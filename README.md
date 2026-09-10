# analytics-magicworld

Backend próprio de analytics do app **Magic World** (iOS, SwiftUI, StoreKit 2).

Mede o funil que a App Store não mostra: quantas pessoas **viram** o paywall,
quantas **abriram a folha de pagamento**, e quantas **concluíram**. A App Store
só conta a última.

Fastify + Postgres (ou SQLite no desenvolvimento), sem dependências além de
`fastify` e `pg`.

---

## Como o funil funciona

```
app_open
   │
paywall_view ──► checkout_initiated ──►┬── start_trial   (anual: 1 semana grátis)
                                       └── subscribe     (mensal, ou anual sem
                                                          direito ao período grátis)
```

Dois pontos que definem tudo o que está abaixo:

**`start_trial` e `subscribe` são irmãos, não uma sequência.** O app emite um
OU outro no mesmo instante, dependendo de o produto ter período grátis e de a
pessoa ter direito a ele. Tratar como sequência produz números sem significado:
dez compras mensais e dez trials anuais no mesmo dia leriam como "100% de
conversão de trial". Por isso o funil tem três passos, e a divisão entre os dois
ramos aparece embaixo, sem taxa entre eles.

**O funil conta pessoas, não disparos.** Todos os passos são
`COUNT(DISTINCT user_id)`. Quem abriu o paywall cinco vezes e não comprou é uma
pessoa que não comprou, não cinco. O volume bruto de aberturas aparece à parte —
reabrir muito é sinal de dúvida de preço, e vale ver.

## O que este backend não mede

**A conversão de período grátis para pago.** Ela acontece dias depois, no
servidor da Apple, com o app fechado. Não é observável daqui.

O app emite `subscription_renewed` quando o StoreKit entrega a transação com o
app aberto, o que cobre parte dos casos, mas não todos: quem cancela antes do
fim, ou renova e nunca mais abre o app, não aparece. **Não trate o número de
renovações como MRR.**

Para medir isso de verdade é preciso
[App Store Server Notifications v2](https://developer.apple.com/documentation/appstoreservernotifications)
apontando para um endpoint próprio. Está fora do escopo deste repositório.

Por isso não existe aqui nenhuma taxa `trial → pago`. Um número inventado com
cara de medição é pior que um espaço em branco.

---

## Rodando na sua máquina

```bash
cp .env.example .env      # e edite
npm install
npm run seed              # dados falsos, ~14 dias, só pra ver a forma
npm run dev
```

Abre em `http://localhost:3000`. O dashboard pede o `ADMIN_TOKEN` na primeira
visita e guarda no `localStorage`.

Sem `DATABASE_URL`, o servidor usa SQLite em `./data/analytics.db`. Isso é
normal e o dado **persiste** — o que é efêmero no Render é o disco do
container, não o SQLite. Por isso o aviso de armazenamento efêmero no
dashboard só aparece quando `NODE_ENV=production`.

Para testar com o app iOS apontando para cá, veja `ANALYTICS.md` no projeto do
app: ligue `sendFromDebugBuilds` e os eventos do simulador caem neste banco em
vez do de produção.
`npm run seed` recusa rodar com `NODE_ENV=production` — dado falso entra na
mesma tabela dos reais e depois não sai.

## Produção (Render)

O `render.yaml` cria o serviço e o banco juntos e injeta `DATABASE_URL`.
`ADMIN_TOKEN` é gerado pelo Render (`generateValue`); pegue no painel, aba
**Environment**. Ele nunca deve existir num arquivo versionado.

### Duas armadilhas do plano free

**O serviço dorme.** Depois de 15 minutos sem tráfego o Render desliga o
container, e a requisição seguinte espera de 30 a 60 segundos pelo cold start.
O cliente iOS tem `timeoutInterval = 60` por causa disso. Com 15 segundos —
como era antes — todo envio que chegasse com o serviço frio morria no timeout, e
com app de baixo tráfego o serviço está quase sempre frio.

**O Postgres free expira em 30 dias.** Quando isso acontece, `DATABASE_URL`
some e o servidor **sobe normalmente** usando SQLite em disco efêmero: aceita
eventos, responde 202, e apaga tudo no próximo restart. De fora é idêntico a
"ninguém usou o app".

Por isso `GET /health` diz qual driver subiu, e o dashboard mostra um aviso no
topo quando o armazenamento é efêmero. Se você for deixar isto rodando de
verdade, tire o banco do Render (Neon e Supabase não expiram nem dormem junto
com o serviço). O serviço web pode continuar dormindo — o cliente espera.

---

## Endpoints

### `POST /events` — público

Um evento ou um lote. Sempre responde `202` quando aceita, para o cliente nunca
travar esperando a gravação.

```json
{ "events": [
  { "event": "paywall_view", "ts": 1789000000000,
    "params": { "user_id": "…", "source": "story_gate", "platform": "ios" } }
] }
```

Limites: 100 eventos por requisição, 32 KB de corpo, 240 requisições por minuto
por IP. Evento com nome fora de `^[a-z][a-z0-9_]{0,63}$` é descartado e contado
em `rejected`; o lote inteiro não é rejeitado por causa de um item ruim.

### `GET /health` — público

O diagnóstico mais rápido que existe aqui. Não pede token: não há nada além de
um total agregado, e um diagnóstico que exige token é um diagnóstico que você
não faz do celular.

```json
{ "ok": true, "driver": "postgres", "ephemeral": false, "events": 4213 }
```

`driver: "sqlite"` em produção significa que o dado está indo para um disco que
some. `ok: false` significa que o servidor está no ar mas não fala com o banco.

### `/admin/*` — exige `Authorization: Bearer <ADMIN_TOKEN>`

| Rota | O que devolve |
| --- | --- |
| `GET /admin/funnel` | Passos do funil em pessoas distintas, mais as taxas |
| `GET /admin/revenue` | Uma linha por moeda, sem conversão cambial |
| `GET /admin/sources` | Funil recortado por origem do paywall |
| `GET /admin/countries` | Funil recortado por país |
| `GET /admin/counts` | Volume por tipo de evento |
| `GET /admin/events` | Lista crua. `limit` (máx. 500), `offset`, `event` |
| `DELETE /admin/clear?confirm=DELETE_ALL` | Apaga tudo |

Todas aceitam `?since=24h` · `7d` · `30d` · `all` · ou um timestamp em ms.

`sources` e `countries` são agregados sobre o período inteiro, no banco. Não
monte esses recortes no navegador a partir de `/admin/events`: aquilo devolve no
máximo 500 linhas, então a tabela sairia de uma amostra das últimas centenas de
eventos em vez do período escolhido.

---

## Eventos

| Evento | Quando |
| --- | --- |
| `app_open` | Abertura fria do app. **Não** dispara ao voltar do segundo plano |
| `paywall_view` | O paywall apareceu. Sempre com `source` |
| `checkout_initiated` | Tocou em assinar, **antes** da folha do StoreKit |
| `start_trial` | Compra concluída entrando em período grátis. `value` = 0 |
| `subscribe` | Compra concluída com cobrança imediata |
| `subscription_renewed` | Renovação que chegou com o app aberto. Ver as ressalvas acima |

`app_open` dispara só na abertura fria porque, ligado a toda volta ao primeiro
plano, ele contava também Central de Controle, notificação e — principalmente —
a folha de pagamento do StoreKit, que tira o app do estado ativo e devolve. O
resultado era um denominador inflado justamente por quem comprou.

### Origens do paywall (`source`)

| Valor | Onde |
| --- | --- |
| `intro` | Abre sozinho depois do onboarding |
| `story_gate` | A pessoa tentou abrir uma história bloqueada |
| `home` | Botão na Home |
| `profile` | Botão no Perfil |

Sem isto, o paywall que a pessoa procurou e o paywall que caiu na cara dela
viram o mesmo número, e `view_to_checkout` fica ilegível. Eventos gravados antes
da versão 1.5 do app não têm `source` e aparecem como `(desconhecido)`.

### Campos aceitos em `params`

`user_id` · `session_id` · `platform` · `app_version` · `country` · `locale` ·
`currency` · `value` · `product_id` · `source`

São aceitos em `snake_case` e `camelCase`. O bag inteiro é guardado em
`params_json`; os campos acima também vão para colunas indexadas. Timestamp de
cliente mais de 30 dias no futuro ou 365 no passado é substituído pelo horário
do servidor — relógio de aparelho erra.

---

## Privacidade

`user_id` é um UUID sorteado na primeira execução do app e guardado localmente.
Não é identificador de aparelho, não segue a pessoa entre apps nem entre
aparelhos, e some na desinstalação. Ainda assim é dado coletado, e precisa estar
declarado no rótulo de privacidade da App Store como *Identifiers* e *Product
Interaction*, ligado a **Analytics** e marcado como **não** usado para
rastreamento.

Não são enviados: IDFA, nome, e-mail, progresso de leitura ou título de conto.
Um app de história infantil não precisa saber o que a criança leu para saber se
o paywall converte. Este backend não tem onde receber essas coisas.

## Estrutura

```
src/
  config.ts          env em um lugar só, e qual driver este boot usa
  server.ts          boot, CORS, dashboard estático
  db/
    index.ts         interface Db, tipos, nomes de evento do funil
    pg.ts            Postgres (produção)
    sqlite-core.ts   todas as consultas SQLite, uma vez só
    sqlite.ts        abre node:sqlite
    sqlite-bun.ts    abre bun:sqlite
  routes/
    ingest.ts        POST /events, GET /health
    admin.ts         /admin/*
  lib/
    normalize.ts     params → colunas
    rateLimit.ts     token bucket em memória, por IP
public/index.html    dashboard, uma página, sem build
scripts/seed.ts      dados falsos para desenvolvimento
```

Os dois drivers SQLite compartilham `sqlite-core.ts` porque antes eram cópias
linha a linha um do outro — e a forma mais fácil do funil do desenvolvimento
divergir do de produção era alguém corrigir uma cópia e esquecer a outra.
