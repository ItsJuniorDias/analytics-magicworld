/**
 * Apple storefront (alpha-3) -> ISO 3166-1 alpha-2.
 *
 * Apple sends the store country as THREE letters ("BRA", "USA") in
 * `storefront`, but the events table stores two-letter country codes (the app
 * sends locale/region that way, and the dashboard turns them into flags).
 * Without the conversion every webhook event would land under a different
 * country than the same user's funnel events, and the two would never line up.
 *
 * The table below is the full ISO 3166-1 list (249 entries), not a curated
 * subset: a partial list fails silently on the one market you did not think
 * of. Stored as packed triples+pairs (ABW->AW, AFG->AF, ...) and expanded into
 * a Map on first use -- ~1.2 KB of source, zero dependencies.
 */

const ALPHA3_ALPHA2 =
  "ABWAWAFGAFAGOAOAIAAIALAAXALBALANDADAREAEARGARARMAMASMASATAAQATFTFATGAGAUSAUAUTATAZEAZBDIBIBELBEBENBJ" +
  "BESBQBFABFBGDBDBGRBGBHRBHBHSBSBIHBABLMBLBLRBYBLZBZBMUBMBOLBOBRABRBRBBBBRNBNBTNBTBVTBVBWABWCAFCFCANCA" +
  "CCKCCCHECHCHLCLCHNCNCIVCICMRCMCODCDCOGCGCOKCKCOLCOCOMKMCPVCVCRICRCUBCUCUWCWCXRCXCYMKYCYPCYCZECZDEUDE" +
  "DJIDJDMADMDNKDKDOMDODZADZECUECEGYEGERIERESHEHESPESESTEEETHETFINFIFJIFJFLKFKFRAFRFROFOFSMFMGABGAGBRGB" +
  "GEOGEGGYGGGHAGHGIBGIGINGNGLPGPGMBGMGNBGWGNQGQGRCGRGRDGDGRLGLGTMGTGUFGFGUMGUGUYGYHKGHKHMDHMHNDHNHRVHR" +
  "HTIHTHUNHUIDNIDIMNIMINDINIOTIOIRLIEIRNIRIRQIQISLISISRILITAITJAMJMJEYJEJORJOJPNJPKAZKZKENKEKGZKGKHMKH" +
  "KIRKIKNAKNKORKRKWTKWLAOLALBNLBLBRLRLBYLYLCALCLIELILKALKLSOLSLTULTLUXLULVALVMACMOMAFMFMARMAMCOMCMDAMD" +
  "MDGMGMDVMVMEXMXMHLMHMKDMKMLIMLMLTMTMMRMMMNEMEMNGMNMNPMPMOZMZMRTMRMSRMSMTQMQMUSMUMWIMWMYSMYMYTYTNAMNA" +
  "NCLNCNERNENFKNFNGANGNICNINIUNUNLDNLNORNONPLNPNRUNRNZLNZOMNOMPAKPKPANPAPCNPNPERPEPHLPHPLWPWPNGPGPOLPL" +
  "PRIPRPRKKPPRTPTPRYPYPSEPSPYFPFQATQAREUREROURORUSRURWARWSAUSASDNSDSENSNSGPSGSGSGSSHNSHSJMSJSLBSBSLESL" +
  "SLVSVSMRSMSOMSOSPMPMSRBRSSSDSSSTPSTSURSRSVKSKSVNSISWESESWZSZSXMSXSYCSCSYRSYTCATCTCDTDTGOTGTHATHTJKTJ" +
  "TKLTKTKMTMTLSTLTONTOTTOTTTUNTNTURTRTUVTVTWNTWTZATZUGAUGUKRUAUMIUMURYUYUSAUSUZBUZVATVAVCTVCVENVEVGBVG" +
  "VIRVIVNMVNVUTVUWLFWFWSMWSYEMYEZAFZAZMBZMZWEZW";

let table: Map<string, string> | null = null;

function lookup(): Map<string, string> {
  if (!table) {
    table = new Map();
    for (let i = 0; i < ALPHA3_ALPHA2.length; i += 5) {
      table.set(ALPHA3_ALPHA2.slice(i, i + 3), ALPHA3_ALPHA2.slice(i + 3, i + 5));
    }
  }
  return table;
}

/**
 * "BRA" -> "BR". Returns null for anything that is not a real ISO alpha-3
 * code, including the placeholder storefronts Apple uses in sandbox.
 *
 * Passes alpha-2 through unchanged so callers need not know the source format.
 */
export function storefrontToAlpha2(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) return code;
  if (!/^[A-Z]{3}$/.test(code)) return null;
  return lookup().get(code) ?? null;
}
