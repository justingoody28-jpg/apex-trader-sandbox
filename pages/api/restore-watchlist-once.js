// ONE-SHOT RESTORE ENDPOINT — safe to hit only when apex_watchlist.active is EMPTY
// Created 2026-04-20 by v3 build session to recover from watchlist.html bug-induced wipe
// DELETE THIS FILE AFTER USE.
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const SYMBOLS_414 = ["ATER","LAZR","MRNA","AGEN","GFAI","IONQ","FCEL","RCKT","SPCE","HUT","WOLF","PAYO","FLYW","TASK","MNDY","NRDS","MAPS","RSKD","AMBR","CLBK","OBNK","HBCP","BSVN","ORRF","MCBC","NWIN","FSBC","OPAD","VZIO","SOUN","CPTN","VNET","ARQQ","QUBT","SDGR","LQDT","SPRY","TGTX","CDNA","VERV","KRYS","AGIO","XBIT","DRTS","REGN","GOSS","NVAX","OCGN","SRPT","HRTX","MESO","ESSA","TELA","ATRC","PRCT","SILK","RNXT","WTTR","KLXE","NINE","BORR","PTEN","PUMP","NR","PFIE","DNOW","GPOR","KCAL","TPVG","XPOF","PLBY","LAZY","GIII","CATO","SCVL","DXLG","CURV","BURL","CULP","ITRN","HIMS","BARK","PETQ","GENC","HLIO","FWRD","HTLD","USAK","ATSG","AIRT","GLDD","MFAC","NVEE","CLPR","NXRT","GOOD","LAND","GIPR","PKST","JBGS","AIV","GMRE","CLDT","SHAK","KRUS","FWRG","ARCO","PZZA","NAPA","TWLO","COIN","HUBS","OKTA","SNAP","HOOD","CRWD","DDOG","SOFI","GLOB","EXLS","PEGA","NCNO","ALRM","JAMF","TNET","ATEN","LPSN","DOMO","QTWO","EVBG","BRZE","ASAN","UMBF","WTFC","SNV","IBOC","PRSP","CATY","FFIN","WSBC","CVBF","FULT","INVA","PRGO","HALO","NTRA","MDRX","OMCL","PINC","ADUS","AMSF","ACAD","NVCR","RYTM","RARE","FOLD","CRDF","ARQT","XNCR","IMVT","PRAX","KYMR","BOOT","WING","FRPT","CAVA","SG","TACO","TXRH","FAT","RRGB","JACK","ACVA","PRTY","VSCO","JOANN","ODP","RCII","ASTE","HCSG","TREX","APOG","ARCB","MATX","MRTN","SAIA","LSTR","ECHO","CEIX","ARCH","SWN","RRC","CIVI","VTLE","SM","REX","HESM","SRLP","IOSP","KWR","TROX","MTRN","ASIX","KREF","GPMT","STWD","BXMT","TRTX","AMD","NVDA","INTC","TSLA","AMZN","AAPL","GOOGL","META","NFLX","MSFT","JPM","GS","LLY","PFE","UNH","STX","NCLH","DOW","APA","LYB","EL","SIRI","MGM","RRX","KLAC","WYNN","OMC","EXPE","LVS","LYV","BMY","ELV","BDX","ZBH","RF","BKR","DVN","STZ","HSY","CPB","SJM","XYL","ACCO","GEF","NYT","SRE","XEL","CDNS","CI","VRTX","C","TFC","FITB","F","RCL","PH","DOV","AVY","AEP","EMR","CLF","MU","WDC","HUM","LRCX","CCL","IP","LUMN","HPQ","GM","GNRC","DELL","AMAT","DENN","ALKS","GO","CSTM","APPF","FLNG","AXON","FIVE","LNTH","SUPN","ANDE","CALM","HLIT","NXST","OOMA","KNTK","HAYW","HAFC","CVGW","JBSS","ACRS","FORM","DLTH","RCUS","LGCY","AVAV","RYAM","EVC","CODA","BTBT","DMAC","GTN","KALA","IQ","VIST","SE","ILMN","CE","FMC","WERN","ANET","ROKU","J","GLW","IDXX","EQT","SCCO","LBRDA","INFY","HPE","A","KKR","ODFL","KNX","NTAP","SPGI","MCO","NDAQ","GPC","NSC","CSX","URI","ACN","EPAM","MDT","EW","WAT","BX","APO","MSCI","CTRA","TRGP","TSCO","CMG","TSN","RPM","LBRDK","EIX","WIT","CRK","ATUS","OLN","BIDU","LW","BTE","ONTO","HCC","CRGY","VAL","KBH","KRO","YETI","MUR","TALO","CROX","FIVN","ANIP","OLLI","UAA","TPH","SYNA","MHO","CNK","INDB","BCC","MSGE","HQY","PNTG","NBTB","EBC","LEVI","USFD","COKE","MIDD","RBC","WOR","CHTR","RMBS","LGIH","HPK","CORT","ACHC","BRBR","PD","LSCC","STRL","FRO","POWI","SOC","DHI","IMAX","IRWD","SMTC"];

const EXCLUDED_STRUCTURE = {
  A: [], B: [], C: [], D: [], F: [], G: [], H: [],
  E1: [], E2: [], E3: [], E4: [],
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // Read current state
    const { data: current, error: readErr } = await supabase
      .from('apex_watchlist')
      .select('*')
      .eq('id', 'default')
      .single();

    if (readErr && readErr.code !== 'PGRST116') {
      return res.status(500).json({ ok: false, step: 'read', error: readErr.message });
    }

    const currentActive = current?.active || [];

    // SAFETY: refuse if active is already populated — don't clobber valid data
    if (currentActive.length > 0) {
      return res.status(409).json({
        ok: false,
        step: 'safety_check',
        reason: 'active_list_not_empty',
        currentActiveCount: currentActive.length,
        message: 'Refusing to restore. apex_watchlist.active is not empty. Delete existing state first if you really want to restore.',
      });
    }

    // Preserve any existing excluded structure if sensible, else use default
    const existingExcluded = (current?.excluded && typeof current.excluded === 'object' && !Array.isArray(current.excluded))
      ? current.excluded
      : EXCLUDED_STRUCTURE;

    // Write the 414 symbols
    const { data: saved, error: writeErr } = await supabase
      .from('apex_watchlist')
      .upsert({
        id: 'default',
        active: SYMBOLS_414,
        excluded: existingExcluded,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (writeErr) {
      return res.status(500).json({ ok: false, step: 'write', error: writeErr.message });
    }

    return res.status(200).json({
      ok: true,
      restored: SYMBOLS_414.length,
      firstFive: SYMBOLS_414.slice(0, 5),
      lastFive: SYMBOLS_414.slice(-5),
      updated_at: saved.updated_at,
      message: 'Successfully restored 414 tickers to apex_watchlist.active. Delete /api/restore-watchlist-once now.',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, step: 'exception', error: e.message });
  }
}
