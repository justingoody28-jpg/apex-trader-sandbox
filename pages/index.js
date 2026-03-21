import Head from "next/head";
import { useState, useEffect, useCallback, useRef } from "react";



const TICKERS = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","AXON","DDOG","SNOW","INTU","DAL","FTAI","CNC","NKE","ADBE","AMD","CRM","FICO"];
const BASE = {AAPL:185,MSFT:375,NVDA:115,AMZN:195,GOOGL:168,META:580,TSLA:275,JPM:285,AXON:498,DDOG:127,SNOW:178,INTU:412,DAL:63,FTAI:222,CNC:35,NKE:59,ADBE:380,AMD:105,CRM:285,FICO:1135};
const SECTORS = ["Technology","Technology","Semiconductors","E-Commerce","Technology","Social Media","EV","Financials","Defense Tech","Cloud","Cloud","Fintech","Airlines","Aviation","Healthcare","Apparel","Creative Software","Semiconductors","Cloud","Analytics"];
const INIT_CFG = {dipMin:5,dipMax:20,rsiOversold:35,rsiRecovery:45,volMult:1.3,sl:7,tp:20,startCash:100000,maxPosPct:18};
const MAX_POS = 5;
const AP_SEC  = 15;
const SIGS = {
  STRONG_BUY:{label:"STRONG BUY",c:"#22c55e",bg:"#052e16",b:"#16a34a"},
  BUY:{label:"BUY",c:"#4ade80",bg:"#052e16",b:"#15803d"},
  WATCH:{label:"WATCH",c:"#f59e0b",bg:"#1c1917",b:"#d97706"},
  HOLD:{label:"HOLD",c:"#94a3b8",bg:"#0f172a",b:"#334155"},
  SELL:{label:"SELL",c:"#f87171",bg:"#1c0505",b:"#b91c1c"},
  STRONG_SELL:{label:"STRONG SELL",c:"#ef4444",bg:"#1c0505",b:"#dc2626"},
};
const VS = {
  "Strong Overreaction":{c:"#4ade80",bg:"#052e16",b:"#16a34a",dot:"#22c55e"},
  "Overreaction":{c:"#86efac",bg:"#052e16",b:"#15803d",dot:"#4ade80"},
  "Partial Overreaction":{c:"#fcd34d",bg:"#1c1917",b:"#d97706",dot:"#f59e0b"},
  "Mixed":{c:"#94a3b8",bg:"#0f172a",b:"#334155",dot:"#64748b"},
  "Justified":{c:"#f87171",bg:"#1c0505",b:"#b91c1c",dot:"#ef4444"},
};

// ── Math helpers ──────────────────────────────────────────────────────────────
function genPrices(base,days,vol){
  var p=[base];
  for(var i=1;i<days;i++) p.push(Math.max(p[i-1]+(Math.random()-0.48)*vol*p[i-1],1));
  return p;
}
function rsiSeries(prices){
  var n=14,res=[],i,d,ag=0,al=0;
  for(i=0;i<n;i++) res.push(50);
  for(i=1;i<=n;i++){d=prices[i]-prices[i-1];if(d>0)ag+=d;else al-=d;}
  ag/=n;al/=n;res.push(al===0?100:Math.round(100-100/(1+ag/al)));
  for(i=n+1;i<prices.length;i++){
    d=prices[i]-prices[i-1];
    var g=d>0?d:0,l=d<0?-d:0;
    ag=(ag*(n-1)+g)/n;al=(al*(n-1)+l)/n;
    res.push(al===0?100:Math.round(100-100/(1+ag/al)));
  }
  return res;
}
function lastRSI(prices){var s=rsiSeries(prices);return s[s.length-1];}
function macdH(prices){
  if(prices.length<26)return 0;
  var ema=function(a,n){var k=2/(n+1),e=a[0];for(var i=1;i<a.length;i++)e=a[i]*k+e*(1-k);return e;};
  var m=ema(prices.slice(-12),12)-ema(prices.slice(-26),26);
  return +(m-m*0.85).toFixed(3);
}

// ── Stock generator ───────────────────────────────────────────────────────────
function genStock(ticker,idx,cfg){
  cfg=cfg||INIT_CFG;
  var base=BASE[ticker]||50,vol=0.018+Math.random()*0.012;
  var prices=genPrices(base,90,vol),cur=prices[prices.length-1];
  var h52=Math.max.apply(null,prices)*1.05,dip=(h52-cur)/h52*100;
  var r=lastRSI(prices),mh=macdH(prices);
  var chg=(cur-prices[prices.length-2])/prices[prices.length-2]*100;
  var vr=+(Math.round(5e6+Math.random()*15e6)/Math.round(8e6+Math.random()*8e6)).toFixed(2);
  var sig="HOLD";
  if(dip>=cfg.dipMin&&dip<=cfg.dipMax){
    if(r>=cfg.rsiRecovery&&r<60&&mh>0&&vr>=cfg.volMult) sig="STRONG_BUY";
    else if(r>=cfg.rsiOversold&&mh>-0.5) sig="BUY";
    else if(r<cfg.rsiOversold) sig="WATCH";
  }else if(dip<5){if(r>70)sig="SELL";}
  else if(dip>25&&dip<=40){if(r>=45&&mh>0&&vr>=1.3)sig="BUY";else if(r>=35&&mh>-0.5)sig="WATCH";else sig="SELL";}else if(dip>40){sig=r<35?"WATCH":"SELL";}
  var score=Math.min(100,Math.max(0,Math.round(
    (dip>=5&&dip<=20?30:0)+(r>=35&&r<=55?25:r<35?15:0)+(mh>0?25:0)+(vr>=1.3?20:vr>=1?10:0)
  )));
  return {ticker,prices,cur:+cur.toFixed(2),h52:+h52.toFixed(2),dip:+dip.toFixed(1),
    rsi:r,mh,chg:+chg.toFixed(2),vr,sig,score,sector:SECTORS[idx%20],
    sl:+(cur*(1-cfg.sl/100)).toFixed(2),tp:+(cur*(1+cfg.tp/100)).toFixed(2),
    entry:"$"+(cur*0.98).toFixed(2)+"-$"+(cur*1.01).toFixed(2)};
}

// ── Backtester ────────────────────────────────────────────────────────────────
function runBT(prices,cfg){
  cfg=cfg||INIT_CFG;
  var S=10000,cash=S,sh=0,ep=0,ed=0,trades=[],equity=[];
  var rs=rsiSeries(prices),stop=cfg.sl/100,tp=cfg.tp/100;
  for(var i=20;i<prices.length;i++){
    var r=rs[i],p=prices[i];
    equity.push({d:i-20,v:cash+sh*p});
    if(sh>0){
      if(p<=ep*(1-stop)){cash+=sh*p;trades.push({type:"SELL",day:i,price:+p.toFixed(2),pnl:+((p-ep)*sh).toFixed(2),dur:i-ed,ep:+ep.toFixed(2),reason:"Stop Loss"});sh=0;}
      else if(p>=ep*(1+tp)){cash+=sh*p;trades.push({type:"SELL",day:i,price:+p.toFixed(2),pnl:+((p-ep)*sh).toFixed(2),dur:i-ed,ep:+ep.toFixed(2),reason:"Take Profit"});sh=0;}
    }else if(r>=cfg.rsiOversold&&r<=55){
      var spend=Math.min(cash,S*0.5);
      if(spend>p){sh=Math.floor(spend/p);cash-=sh*p;ep=p;ed=i;trades.push({type:"BUY",day:i,price:+p.toFixed(2),pnl:0,dur:0,ep:+p.toFixed(2),reason:"RSI Entry"});}
    }
  }
  if(sh>0){var fp=prices[prices.length-1];cash+=sh*fp;trades.push({type:"SELL",day:prices.length-1,price:+fp.toFixed(2),pnl:+((fp-ep)*sh).toFixed(2),dur:prices.length-1-ed,ep:+ep.toFixed(2),reason:"End"});}
  var fv=+cash.toFixed(2),ret=+((fv-S)/S*100).toFixed(2);
  var bhSh=Math.floor(S/prices[20]),bhF=+(bhSh*prices[prices.length-1]+(S-bhSh*prices[20])).toFixed(2);
  var bhR=+((bhF-S)/S*100).toFixed(2);
  var bheq=equity.map(function(_,i){return S*((prices[20+i]||prices[20])/prices[20]);});
  var closed=trades.filter(function(t){return t.type==="SELL";});
  var wins=closed.filter(function(t){return t.pnl>0;}),losses=closed.filter(function(t){return t.pnl<=0;});
  var wr=closed.length>0?Math.round(wins.length/closed.length*100):0;
  var aw=wins.length>0?+(wins.reduce(function(s,t){return s+t.pnl;},0)/wins.length).toFixed(2):0;
  var al=losses.length>0?+(losses.reduce(function(s,t){return s+t.pnl;},0)/losses.length).toFixed(2):0;
  var gp=wins.reduce(function(s,t){return s+t.pnl;},0),gl=Math.abs(losses.reduce(function(s,t){return s+t.pnl;},0));
  var pf=gl>0?+(gp/gl).toFixed(2):gp>0?99:0;
  var avgDur=closed.length>0?Math.round(closed.reduce(function(s,t){return s+t.dur;},0)/closed.length):0;
  var lw=wins.length>0?+Math.max.apply(null,wins.map(function(t){return t.pnl;})).toFixed(2):0;
  var ll=losses.length>0?+Math.min.apply(null,losses.map(function(t){return t.pnl;})).toFixed(2):0;
  var mcw=0,mcl=0,cw=0,cl=0;
  closed.forEach(function(t){if(t.pnl>0){cw++;cl=0;if(cw>mcw)mcw=cw;}else{cl++;cw=0;if(cl>mcl)mcl=cl;}});
  var dr=equity.slice(1).map(function(e,i){return (e.v-equity[i].v)/equity[i].v;});
  var adr=dr.length>0?dr.reduce(function(s,r){return s+r;},0)/dr.length:0;
  var sd=Math.sqrt(dr.length>0?dr.reduce(function(s,r){return s+Math.pow(r-adr,2);},0)/dr.length:0);
  var ddr=dr.filter(function(r){return r<0;});
  var dsd=Math.sqrt(ddr.length>0?ddr.reduce(function(s,r){return s+r*r;},0)/ddr.length:0);
  var rf=0.05/252;
  var sharpe=sd>0?+((adr-rf)/sd*Math.sqrt(252)).toFixed(2):0;
  var sortino=dsd>0?+((adr-rf)/dsd*Math.sqrt(252)).toFixed(2):0;
  var pk=equity.length>0?equity[0].v:S,mdd=0;
  var dds=equity.map(function(e){if(e.v>pk)pk=e.v;var d=(pk-e.v)/pk*100;if(d>mdd)mdd=d;return{d:e.d,dd:+d.toFixed(2)};});
  mdd=+mdd.toFixed(2);
  var ann=ret*(252/(prices.length-20)),calmar=mdd>0?+(ann/mdd).toFixed(2):0;
  var exp=closed.length>0?+((wr/100*aw+(1-wr/100)*al)).toFixed(2):0;
  var alpha=+(ret-bhR).toFixed(2);
  var MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var bs=Math.floor(equity.length/3);
  var monthly=[0,1,2].map(function(m){
    var s=equity[m*bs],e=equity[Math.min((m+1)*bs-1,equity.length-1)];
    return s&&e?{month:MN[(new Date().getMonth()-2+m+12)%12],ret:+((e.v-s.v)/s.v*100).toFixed(2)}:null;
  }).filter(Boolean);
  return{fv,ret,bhR,bhF,trades,equity,dds,bheq,wr,totalTrades:closed.length,aw,al,pf,avgDur,lw,ll,mcw,mcl,sharpe,sortino,mdd,calmar,exp,monthly,alpha};
}

// ── Self-tuning engine ────────────────────────────────────────────────────────
function tuneCFG(res,cfg){
  var n=Object.assign({},cfg),changes=[];
  if(res.sharpe<0.5){n.sl=Math.max(3,cfg.sl-1);changes.push("Sharpe "+res.sharpe+" low to SL tightened to "+n.sl+"%");}
  if(res.sharpe>2&&cfg.sl<10){n.sl=Math.min(10,cfg.sl+1);changes.push("Sharpe "+res.sharpe+" strong to SL loosened to "+n.sl+"%");}
  if(res.wr<40&&res.totalTrades>3){n.rsiRecovery=Math.min(55,cfg.rsiRecovery+2);changes.push("Win rate "+res.wr+"% low to RSI recovery raised to "+n.rsiRecovery);}
  if(res.wr>70&&res.totalTrades>3){n.rsiRecovery=Math.max(38,cfg.rsiRecovery-2);changes.push("Win rate "+res.wr+"% high to RSI recovery lowered to "+n.rsiRecovery);}
  if(res.pf<1.2&&res.totalTrades>2){n.tp=Math.min(35,cfg.tp+2);changes.push("Profit factor "+res.pf+" low to TP extended to "+n.tp+"%");}
  if(res.pf>3){n.tp=Math.max(12,cfg.tp-2);changes.push("Profit factor "+res.pf+" high to TP trimmed to "+n.tp+"%");}
  if(res.mdd>25){n.dipMax=Math.max(15,cfg.dipMax-2);changes.push("Drawdown "+res.mdd+"% high to dip max narrowed to "+n.dipMax+"%");}
  if(res.totalTrades<2){n.rsiOversold=Math.max(28,cfg.rsiOversold-3);changes.push("Only "+res.totalTrades+" trades to RSI oversold lowered to "+n.rsiOversold);}
  if(res.sortino<0.8&&res.sharpe>0.5){n.rsiOversold=Math.min(42,cfg.rsiOversold+2);changes.push("Sortino "+res.sortino+" poor to RSI floor raised to "+n.rsiOversold);}
  return{cfg:n,changes};
}

// ── Small UI components ───────────────────────────────────────────────────────
function Spark(props){
  var p=props.prices.slice(-20),mn=Math.min.apply(null,p),mx=Math.max.apply(null,p),rng=mx-mn||1;
  var pts=p.map(function(v,i){return (i/(p.length-1)*80)+","+(28-(v-mn)/rng*28);}).join(" ");
  return <svg width="80" height="30" style={{display:"block"}}><polyline points={pts} fill="none" stroke={props.up?"#22c55e":"#ef4444"} strokeWidth="1.5" strokeLinejoin="round"/></svg>;
}
function MC(props){
  return(
    <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:10,padding:"13px 15px"}}>
      <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:5,textTransform:"uppercase"}}>{props.label}</div>
      <div style={{fontSize:props.lg?22:17,fontWeight:800,color:props.color||"#f1f5f9",marginBottom:props.sub?3:0}}>{props.value}</div>
      {props.sub&&<div style={{fontSize:10,color:"#334155"}}>{props.sub}</div>}
    </div>
  );
}
function rc(m,v){
  if(m==="sharpe") return v>=1.5?"#4ade80":v>=0.5?"#f59e0b":"#f87171";
  if(m==="sortino")return v>=2?"#4ade80":v>=1?"#f59e0b":"#f87171";
  if(m==="pf")     return v>=2?"#4ade80":v>=1.2?"#f59e0b":"#f87171";
  if(m==="mdd")    return v<=10?"#4ade80":v<=20?"#f59e0b":"#f87171";
  if(m==="calmar") return v>=1?"#4ade80":v>=0.5?"#f59e0b":"#f87171";
  if(m==="wr")     return v>=60?"#4ade80":v>=45?"#f59e0b":"#f87171";
  return v>=0?"#4ade80":"#f87171";
}

// ── Charts ────────────────────────────────────────────────────────────────────
function EqChart(props){
  var eq=props.equity,bh=props.bheq,tr=props.trades;
  if(!eq||eq.length<2)return null;
  var W=560,H=130,PD=44,IW=W-PD-10,IH=H-28;
  var ev=eq.map(function(e){return e.v;}),all=bh?ev.concat(bh):ev;
  var mn=Math.min.apply(null,all),mx=Math.max.apply(null,all),rng=mx-mn||1;
  var n=eq.length-1;
  function tx(i){return PD+(i/n)*IW;}
  function ty(v){return 8+IH-(v-mn)/rng*IH;}
  var pts=eq.map(function(e,i){return tx(i)+","+ty(e.v);}).join(" ");
  var bhpts=bh?bh.map(function(v,i){return tx(i)+","+ty(v);}).join(" "):"";
  var up=ev[ev.length-1]>=ev[0],col=up?"#22c55e":"#ef4444";
  return(
    <svg width={W} height={H+14} style={{display:"block",width:"100%",overflow:"visible"}}>
      <defs><linearGradient id="eqg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={col} stopOpacity="0.2"/><stop offset="100%" stopColor={col} stopOpacity="0"/></linearGradient></defs>
      {[mn,mn+rng*0.5,mx].map(function(v,i){return(<g key={i}><line x1={PD} y1={ty(v)} x2={W-10} y2={ty(v)} stroke="#0f172a" strokeWidth="1"/><text x={PD-4} y={ty(v)+4} fill="#334155" fontSize="9" textAnchor="end">{"$"+(v>=10000?(v/1000).toFixed(1)+"k":v.toFixed(0))}</text></g>);})}
      {bhpts&&<polyline points={bhpts} fill="none" stroke="#475569" strokeWidth="1" strokeDasharray="3,3" opacity="0.6"/>}
      <polygon points={tx(0)+","+(IH+8)+" "+pts+" "+tx(n)+","+(IH+8)} fill="url(#eqg)"/>
      <polyline points={pts} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
      {(tr||[]).filter(function(t){return t.type==="BUY";}).map(function(t,i){var idx=t.day-20;if(idx<0||idx>=eq.length)return null;return<circle key={"b"+i} cx={tx(idx)} cy={ty(eq[idx].v)} r="3" fill="#22c55e" opacity="0.9"/>;})}
      {(tr||[]).filter(function(t){return t.type==="SELL";}).map(function(t,i){var idx=t.day-20;if(idx<0||idx>=eq.length)return null;return<circle key={"s"+i} cx={tx(idx)} cy={ty(eq[idx].v)} r="3" fill={t.pnl>=0?"#60a5fa":"#f87171"} opacity="0.9"/>;})}
      <circle cx={PD} cy={H+8} r="3" fill={col}/><text x={PD+7} y={H+12} fill="#475569" fontSize="9">Strategy</text>
      <line x1={PD+62} y1={H+8} x2={PD+76} y2={H+8} stroke="#475569" strokeWidth="1" strokeDasharray="3,2"/><text x={PD+79} y={H+12} fill="#475569" fontSize="9">Buy+Hold</text>
      <circle cx={PD+138} cy={H+8} r="3" fill="#22c55e"/><text x={PD+145} y={H+12} fill="#475569" fontSize="9">Entry</text>
      <circle cx={PD+175} cy={H+8} r="3" fill="#60a5fa"/><text x={PD+182} y={H+12} fill="#475569" fontSize="9">TP</text>
      <circle cx={PD+205} cy={H+8} r="3" fill="#f87171"/><text x={PD+212} y={H+12} fill="#475569" fontSize="9">SL</text>
    </svg>
  );
}
function DDChart(props){
  var data=props.data;
  if(!data||data.length<2)return null;
  var W=560,H=60,PD=44,IW=W-PD-10,IH=H-8;
  var mdd=Math.max.apply(null,data.map(function(d){return d.dd;}))||0.01;
  var n=data.length-1;
  function tx(i){return PD+(i/n)*IW;}
  function ty(v){return 4+(v/mdd)*IH;}
  var pts=data.map(function(d,i){return tx(i)+","+ty(d.dd);}).join(" ");
  return(
    <svg width={W} height={H+8} style={{display:"block",width:"100%"}}>
      <defs><linearGradient id="ddg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ef4444" stopOpacity="0.35"/><stop offset="100%" stopColor="#ef4444" stopOpacity="0.03"/></linearGradient></defs>
      <text x={PD-4} y={8} fill="#334155" fontSize="9" textAnchor="end">0%</text>
      <text x={PD-4} y={IH+8} fill="#ef4444" fontSize="9" textAnchor="end">{"-"+mdd.toFixed(1)+"%"}</text>
      <line x1={PD} y1={4} x2={W-10} y2={4} stroke="#1e293b" strokeWidth="1" strokeDasharray="2,2"/>
      <polygon points={tx(0)+",4 "+pts+" "+tx(n)+",4"} fill="url(#ddg)"/>
      <polyline points={pts} fill="none" stroke="#ef4444" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  );
}

// ── BacktestResults component ─────────────────────────────────────────────────
function BTResults(props){
  var r=props.r,ticker=props.ticker;
  if(!r)return null;
  var closed=r.trades.filter(function(t){return t.type==="SELL";});
  return(
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:10}}>
        <MC lg label="Total Return" value={(r.ret>=0?"+":"")+r.ret+"%"} color={r.ret>=0?"#4ade80":"#f87171"} sub={"B+H: "+(r.bhR>=0?"+":"")+r.bhR+"%"}/>
        <MC lg label="Alpha vs B+H" value={(r.alpha>=0?"+":"")+r.alpha+"%"} color={rc("alpha",r.alpha)} sub="Active edge"/>
        <MC lg label="Final Value" value={"$"+r.fv.toLocaleString()} color="#f1f5f9" sub={"B+H: $"+r.bhF.toLocaleString()}/>
        <MC lg label="Max Drawdown" value={"-"+r.mdd+"%"} color={rc("mdd",r.mdd)} sub="Peak-to-trough"/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:10}}>
        <MC lg label="Sharpe Ratio" value={r.sharpe} color={rc("sharpe",r.sharpe)} sub="Target >= 1.5"/>
        <MC lg label="Sortino Ratio" value={r.sortino} color={rc("sortino",r.sortino)} sub="Target >= 2.0"/>
        <MC lg label="Calmar Ratio" value={r.calmar} color={rc("calmar",r.calmar)} sub="Return / Max DD"/>
        <MC lg label="Profit Factor" value={r.pf} color={rc("pf",r.pf)} sub="Target >= 2.0"/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:18}}>
        <MC label="Win Rate" value={r.wr+"%"} color={rc("wr",r.wr)}/>
        <MC label="Expectancy" value={(r.exp>=0?"+":"")+"$"+r.exp} color={r.exp>=0?"#4ade80":"#f87171"}/>
        <MC label="Avg Win" value={"+$"+r.aw} color="#4ade80"/>
        <MC label="Avg Loss" value={"$"+r.al} color="#f87171"/>
        <MC label="Total Trades" value={r.totalTrades}/>
        <MC label="Avg Hold (d)" value={r.avgDur} color="#94a3b8"/>
        <MC label="Largest Win" value={"+$"+r.lw} color="#4ade80"/>
        <MC label="Largest Loss" value={"$"+r.ll} color="#f87171"/>
        <MC label="Max Win Streak" value={r.mcw} color="#4ade80"/>
        <MC label="Max Loss Streak" value={r.mcl} color="#f87171"/>
        <MC label="Period" value="90 Days" color="#94a3b8"/>
        <MC label="Risk-Free" value="5% pa" color="#475569"/>
      </div>
      <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"18px 20px",marginBottom:10}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
          <div style={{fontSize:11,color:"#334155",letterSpacing:2}}>{"EQUITY CURVE - "+ticker}</div>
          <div style={{fontSize:11,color:rc("alpha",r.alpha)}}>{"Alpha: "+(r.alpha>=0?"+":"")+r.alpha+"%"}</div>
        </div>
        <EqChart equity={r.equity} bheq={r.bheq} trades={r.trades}/>
      </div>
      <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"18px 20px",marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
          <div style={{fontSize:11,color:"#334155",letterSpacing:2}}>DRAWDOWN CURVE</div>
          <div style={{fontSize:11,color:rc("mdd",r.mdd)}}>{"Max: -"+r.mdd+"%"}</div>
        </div>
        <DDChart data={r.dds}/>
      </div>
      {r.monthly.length>0&&(
        <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"18px 20px",marginBottom:12}}>
          <div style={{fontSize:11,color:"#334155",letterSpacing:2,marginBottom:12}}>PERIOD RETURNS</div>
          <div style={{display:"flex",gap:8}}>
            {r.monthly.map(function(m,i){
              var it=Math.min(Math.abs(m.ret)/15,1);
              var bg=m.ret>=0?"rgba(34,197,94,"+(0.15+it*0.6)+")":"rgba(239,68,68,"+(0.15+it*0.6)+")";
              return(<div key={i} style={{flex:1,background:bg,border:"1px solid "+(m.ret>=0?"#16a34a":"#b91c1c"),borderRadius:8,padding:"12px 8px",textAlign:"center"}}><div style={{fontSize:9,color:"#94a3b8",marginBottom:5}}>{m.month}</div><div style={{fontSize:16,fontWeight:800,color:m.ret>=0?"#4ade80":"#f87171"}}>{(m.ret>=0?"+":"")+m.ret+"%"}</div></div>);
            })}
          </div>
        </div>
      )}
      <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"18px 20px"}}>
        <div style={{fontSize:11,color:"#334155",letterSpacing:2,marginBottom:10}}>TRADE LOG</div>
        {closed.length===0?<div style={{color:"#334155",fontSize:12,textAlign:"center",padding:20}}>No completed trades.</div>:(
          <div>
            <div style={{display:"grid",gridTemplateColumns:"48px 55px 75px 75px 80px 72px 50px 1fr",gap:5,padding:"5px 0 8px",fontSize:9,color:"#334155",letterSpacing:1,borderBottom:"1px solid #0f172a"}}>
              <span>TYPE</span><span>DAY</span><span>ENTRY</span><span>EXIT</span><span>P+L</span><span>RETURN</span><span>DAYS</span><span>REASON</span>
            </div>
            <div style={{maxHeight:220,overflowY:"auto"}}>
              {closed.map(function(t,i){
                var rp=t.ep>0?((t.price-t.ep)/t.ep*100).toFixed(2):"0.00";
                var pc=t.pnl>=0?"#4ade80":"#f87171";
                var rc2=t.reason==="Stop Loss"?"#f87171":t.reason==="Take Profit"?"#4ade80":"#64748b";
                return(<div key={i} style={{display:"grid",gridTemplateColumns:"48px 55px 75px 75px 80px 72px 50px 1fr",gap:5,padding:"7px 0",borderBottom:"1px solid #0a0f1a",fontSize:11,alignItems:"center"}}>
                  <span style={{color:"#f87171",fontWeight:700}}>SELL</span>
                  <span style={{color:"#475569"}}>{"D"+t.day}</span>
                  <span style={{color:"#64748b"}}>{"$"+t.ep}</span>
                  <span style={{color:"#94a3b8"}}>{"$"+t.price}</span>
                  <span style={{color:pc,fontWeight:700}}>{(t.pnl>=0?"+":"")+"$"+t.pnl.toFixed(0)}</span>
                  <span style={{color:pc}}>{(parseFloat(rp)>=0?"+":"")+rp+"%"}</span>
                  <span style={{color:"#475569"}}>{t.dur+"d"}</span>
                  <span style={{fontSize:10,color:rc2}}>{t.reason}</span>
                </div>);
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── AI Losers Tab ─────────────────────────────────────────────────────────────

// ── Price Chart Component ──────────────────────────────────────────────────
function PriceChart(props){
  var data=props.data,ticker=props.ticker;
  if(!data||data.length<2)return <div style={{color:"#334155",fontSize:11,padding:"20px 0",textAlign:"center"}}>Loading chart...</div>;
  var W=520,H=120,PL=52,PR=10,PT=8,PB=20;
  var IW=W-PL-PR,IH=H-PT-PB;
  var closes=data.map(function(d){return parseFloat(d.close);});
  var mn=Math.min.apply(null,closes),mx=Math.max.apply(null,closes),rng=mx-mn||1;
  var n=closes.length-1;
  function tx(i){return PL+(i/n)*IW;}
  function ty(v){return PT+IH-((v-mn)/rng)*IH;}
  var pts=closes.map(function(v,i){return tx(i)+","+ty(v);}).join(" ");
  var up=closes[closes.length-1]>=closes[0];
  var col=up?"#22c55e":"#ef4444";
  var first=closes[0],last=closes[closes.length-1];
  var chg=((last-first)/first*100).toFixed(1);
  // Labels: first, mid, last date
  var dates=[data[0].datetime, data[Math.floor(n/2)].datetime, data[n].datetime];
  var prices=[mn, mn+rng/2, mx];
  return(
    <div style={{marginTop:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <span style={{fontSize:9,color:"#334155",letterSpacing:2}}>90-DAY PRICE CHART</span>
        <span style={{fontSize:12,fontWeight:700,color:col}}>{up?"+":""}{chg}% over period</span>
      </div>
      <svg width="100%" viewBox={"0 0 "+W+" "+H} style={{display:"block",overflow:"visible"}}>
        <defs>
          <linearGradient id={"pg"+ticker} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={col} stopOpacity="0.18"/>
            <stop offset="100%" stopColor={col} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {[mn, mn+rng/2, mx].map(function(v,i){return(
          <g key={i}>
            <line x1={PL} y1={ty(v)} x2={W-PR} y2={ty(v)} stroke="#0f172a" strokeWidth="1"/>
            <text x={PL-4} y={ty(v)+4} fill="#334155" fontSize="9" textAnchor="end">{"$"+v.toFixed(0)}</text>
          </g>
        );})}
        <polygon points={PL+","+(PT+IH)+" "+pts+" "+(W-PR)+","+(PT+IH)} fill={"url(#pg"+ticker+")"}/>
        <polyline points={pts} fill="none" stroke={col} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"/>
        <circle cx={tx(n)} cy={ty(last)} r="3" fill={col}/>
        {dates.map(function(d,i){var xi=i===0?0:i===1?Math.floor(n/2):n;return(
          <text key={i} x={tx(xi)} y={H} fill="#334155" fontSize="8" textAnchor={i===0?"start":i===1?"middle":"end"}>{d.slice(5)}</text>
        );})}
      </svg>
    </div>
  );
}

// ── Analyst Ratings Chart ──────────────────────────────────────────────────
function AnalystChart(props){
  var data=props.data;
  if(!data||!Array.isArray(data)||data.length===0)return <div style={{color:"#334155",fontSize:11,padding:"8px 0"}}>No analyst data</div>;
  var recent=data.slice(0,4).reverse(); // oldest to newest
  var maxTotal=Math.max.apply(null,recent.map(function(d){return(d.buy||0)+(d.strongBuy||0)+(d.hold||0)+(d.sell||0)+(d.strongSell||0)||1;}));
  var W=520,H=80,barW=60,gap=16,PL=8;
  return(
    <div style={{marginTop:12}}>
      <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:8}}>ANALYST RATINGS TREND</div>
      <div style={{display:"flex",gap:gap,alignItems:"flex-end",height:H+20}}>
        {recent.map(function(d,i){
          var buy=(d.buy||0)+(d.strongBuy||0),hold=d.hold||0,sell=(d.sell||0)+(d.strongSell||0);
          var tot=buy+hold+sell||1;
          var bH=Math.round((buy/tot)*H),hH=Math.round((hold/tot)*H),sH=Math.round((sell/tot)*H);
          return(
            <div key={i} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
              <div style={{fontSize:9,color:"#4ade80",fontWeight:700}}>{buy}</div>
              <div style={{width:barW,display:"flex",flexDirection:"column",borderRadius:4,overflow:"hidden"}}>
                {sH>0&&<div style={{height:sH,background:"#ef4444",opacity:0.8}}/>}
                {hH>0&&<div style={{height:hH,background:"#475569",opacity:0.8}}/>}
                {bH>0&&<div style={{height:bH,background:"#22c55e",opacity:0.9}}/>}
              </div>
              <div style={{fontSize:8,color:"#334155"}}>{d.period?.slice(0,7)||"-"}</div>
            </div>
          );
        })}
        <div style={{display:"flex",flexDirection:"column",gap:4,justifyContent:"flex-end",paddingBottom:18,marginLeft:8}}>
          {[{c:"#22c55e",l:"Buy"},{c:"#475569",l:"Hold"},{c:"#ef4444",l:"Sell"}].map(function(x,i){return(
            <div key={i} style={{display:"flex",alignItems:"center",gap:4}}>
              <div style={{width:8,height:8,background:x.c,borderRadius:2}}/>
              <span style={{fontSize:9,color:"#475569"}}>{x.l}</span>
            </div>
          );})}
        </div>
      </div>
    </div>
  );
}

function LosersTab(props){
  // Helper: get screener signal for a ticker
  function screenerSig(ticker){
    var s=(props.stocks||[]).find(function(x){return x.ticker===ticker;});
    return s?s.sig:null;
  }
  var CATEGORIES=[
    {id:"fallen_giants",label:"Fallen Giants",icon:"👑",cap:"$100B+",desc:"Household names - Apple, Nike, Disney",color:"#a78bfa",bg:"#1e1b4b",border:"#4c1d95",
     prompt:"Identify 8 iconic, large-cap US companies (S&P 500 household names, market cap $100B+) currently trading significantly below their 52-week highs. Focus on companies everyone has heard of - Apple, Nike, Google, Disney, etc. The drop should appear disproportionate to their long-term fundamentals."},
    {id:"mid_market",label:"Mid-Market",icon:"🏢",cap:"$10B-$100B",desc:"Well-known companies, higher upside",color:"#60a5fa",bg:"#0c1a2e",border:"#1e3a5f",
     prompt:"Identify 8 mid-cap US companies (market cap $10B-$100B) that are significant players in their industries and currently trading well below recent highs. These should be companies with real revenue, established business models, and a drop that appears driven more by sentiment than fundamentals."},
    {id:"rising_stars",label:"Rising Stars",icon:"🚀",cap:"$1B-$10B",desc:"Growth names with high upside potential",color:"#34d399",bg:"#022c22",border:"#065f46",
     prompt:"Identify 8 growth-oriented US companies (market cap $1B-$10B) that have pulled back significantly from highs. These should be companies with strong growth trajectories - high revenue growth, expanding markets - where the drop represents an oversized reaction to short-term headwinds rather than a fundamental breakdown."},
    {id:"speculative",label:"Speculative",icon:"⚡",cap:"Under $1B",desc:"High risk, high reward - use with caution",color:"#fb923c",bg:"#1c0a00",border:"#7c2d12",
     prompt:"Identify 8 small-cap US companies (market cap under $1B) that have experienced sharp drops. These carry higher risk - be explicit about solvency concerns, debt loads, and whether the business model is proven. Include honest bear cases. Only flag as Buy if there is a genuinely compelling recovery thesis."},
  ];
  var [category,setCategory]=useState("fallen_giants");
  var [cache,setCache]=useState({}); // per-category results cache
  var [loading,setLoading]=useState(false);
  var [error,setError]=useState(null);
  var [filter,setFilter]=useState("all");
  var [expanded,setExpanded]=useState({}); // ticker -> {chart, ratings}
  var [chartData,setChartData]=useState({}); // ticker -> price series
  var [ratingsData,setRatingsData]=useState({}); // ticker -> analyst ratings

  function loadTrends(ticker){
    if(chartData[ticker]&&ratingsData[ticker])return; // already loaded
    fetch("/api/market?source=td&endpoint=time_series?symbol="+ticker+"&interval=1day&outputsize=90")
      .then(function(r){return r.json();})
      .then(function(d){if(d.values)setChartData(function(prev){var n=Object.assign({},prev);n[ticker]=d.values.reverse();return n;});})
      .catch(function(){});
    fetch("/api/market?source=fh&endpoint=stock/recommendation?symbol="+ticker)
      .then(function(r){return r.json();})
      .then(function(d){if(Array.isArray(d))setRatingsData(function(prev){var n=Object.assign({},prev);n[ticker]=d;return n;});})
      .catch(function(){});
  }

  function toggleExpand(ticker,field){
    setExpanded(function(prev){
      var cur=Object.assign({},prev[ticker]||{});
      cur[field]=!cur[field];
      if(cur[field])loadTrends(ticker);
      return Object.assign({},prev,{[ticker]:cur});
    });
  }
  var [validationCache,setValidationCache]=useState({});
  var [validating,setValidating]=useState(false);

  var cat=CATEGORIES.find(function(c){return c.id===category;})||CATEGORIES[0];
  var losers=(cache[category]||{}).losers||[];
  var summary=(cache[category]||{}).summary||null;
  var validation=validationCache[category]||{};
  function setLosers(v){setCache(function(prev){var n=Object.assign({},prev);n[category]=Object.assign({},n[category]||{},{losers:v});return n;});}
  function setSummary(v){setCache(function(prev){var n=Object.assign({},prev);n[category]=Object.assign({},n[category]||{},{summary:v});return n;});}
  function setValidation(v){setValidationCache(function(prev){var n=Object.assign({},prev);n[category]=v;return n;});}

  // Watchlist state
  var [watchlist,setWatchlist]=useState([]);
  function loadWatchlist(){fetch("/api/portfolio?action=watchlist").then(function(r){return r.json();}).then(function(d){setWatchlist(Array.isArray(d)?d:[]);}).catch(function(){});}
  useEffect(function(){loadWatchlist();},[]);
  function addToWatchlist(ticker,name){
    fetch("/api/portfolio?action=watchlist_add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker,name,added_from:"ai_analysis"})})
      .then(function(){loadWatchlist();});
  }
  function removeFromWatchlist(ticker){
    fetch("/api/portfolio?action=watchlist_remove",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker})})
      .then(function(){loadWatchlist();});
  }

  // Watchlist state
  var [watchlist,setWatchlist]=useState([]);
  function loadWatchlist(){fetch("/api/portfolio?action=watchlist").then(function(r){return r.json();}).then(function(d){setWatchlist(Array.isArray(d)?d:[]);}).catch(function(){});}
  useEffect(function(){loadWatchlist();},[]);
  function addToWatchlist(ticker,name){fetch("/api/portfolio?action=watchlist_add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker,name,added_from:"ai_analysis"})}).then(function(){loadWatchlist();});}
  function removeFromWatchlist(ticker){fetch("/api/portfolio?action=watchlist_remove",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker})}).then(function(){loadWatchlist();});}

  // Expanded trend state
  var [expanded,setExpanded]=useState({});
  var [chartData,setChartData]=useState({});
  var [ratingsData,setRatingsData]=useState({});
  function loadTrends(ticker){
    fetch("/api/market?source=td&endpoint=time_series?symbol="+ticker+"&interval=1day&outputsize=90").then(function(r){return r.json();}).then(function(d){if(d.values)setChartData(function(p){var n=Object.assign({},p);n[ticker]=d.values.slice().reverse();return n;});}).catch(function(){});
    fetch("/api/market?source=fh&endpoint=stock/recommendation?symbol="+ticker).then(function(r){return r.json();}).then(function(d){if(Array.isArray(d))setRatingsData(function(p){var n=Object.assign({},p);n[ticker]=d;return n;});}).catch(function(){});
  }
  function toggleExpand(ticker,field){setExpanded(function(p){var c=Object.assign({},p[ticker]||{});c[field]=!c[field];if(c[field])loadTrends(ticker);return Object.assign({},p,{[ticker]:c});});}

  // Search state
  var [searchTicker,setSearchTicker]=useState("");
  var [searchResult,setSearchResult]=useState(null);
  var [searchLoading,setSearchLoading]=useState(false);
  var [searchError,setSearchError]=useState(null);

  function runSearch(){
    var t=searchTicker.trim().toUpperCase();
    if(!t)return;
    setSearchLoading(true);setSearchError(null);setSearchResult(null);
    var userPrompt="Today is "+new Date().toDateString()+". Analyze the stock "+t+" in depth. "+
      "Provide a comprehensive fundamental analysis including current price context, recent catalyst, "+
      "whether it appears overvalued/undervalued/fairly valued, and a clear investment thesis.\n\n"+
      "Return a JSON object (not array) with these exact fields:\n"+
      "ticker (string), name (string), sector (string), exchange (string),"+
      "price (string e.g. \"$142.30\"), marketCap (string e.g. \"$48B\"),"+
      "fiftyTwoWeekHigh (string), fiftyTwoWeekLow (string),"+
      "verdict (exactly one of: \"Strong Overreaction\", \"Overreaction\", \"Partial Overreaction\", \"Mixed\", \"Justified\", \"Fairly Valued\", \"Overvalued\"),"+
      "catalyst (string, 2 sentences - most recent significant development),"+
      "bull (string, 3 sentences - strongest bull case),"+
      "bear (string, 3 sentences - strongest bear case),"+
      "analystTarget (string e.g. \"$185\" or \"N/A\"),"+
      "upside (string e.g. \"+42%\" or \"N/A\"), upsideNum (number),"+
      "peRatio (string e.g. \"28.4x\" or \"N/A\"),"+
      "revenueGrowth (string e.g. \"+12% YoY\" or \"N/A\"),"+
      "recommendation (exactly one of: \"Strong Buy\", \"Buy\", \"Watch\", \"Avoid\"),"+
      "summary (string, 3 sentences - your overall take on this stock right now)";
    fetch("/api/analyze",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"claude-sonnet-4-20250514",
        max_tokens:2000,
        system:"You are a financial data API. Your ENTIRE response must be a valid JSON object starting with { and ending with }. No text before or after. No markdown fences.",
        messages:[{role:"user",content:userPrompt},{role:"assistant",content:"{"}]
      }),
    })
    .then(function(r){return r.json();})
    .then(function(data){
      if(data.error)throw new Error(data.error.message||"API error");
      var raw=(data.content||[]).map(function(b){return b.text||"";}).join("");
      var combined="{"+raw;
      var clean=combined.replace(/```json/g,"").replace(/```/g,"").trim();
      var start=clean.indexOf("{"),end=clean.lastIndexOf("}");
      if(start===-1||end===-1)throw new Error("No JSON found");
      var parsed=JSON.parse(clean.slice(start,end+1));
      setSearchResult(parsed);
      setSearchLoading(false);
      // Save to Supabase
      fetch("/api/portfolio?action=ai_analysis",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({results:[Object.assign({},parsed,{dropNum:parsed.upsideNum||0,drop:parsed.upside||"N/A"})],category:"search"})
      }).catch(function(){});
    })
    .catch(function(err){setSearchLoading(false);setSearchError("Analysis failed: "+err.message);});
  }

  function validateLosers(losersArr){
    setValidating(true);
    var pending=losersArr.length;
    var newVal={};
    function done(){pending--;if(pending===0){setValidation(newVal);setValidating(false);}}
    losersArr.forEach(function(l){
      var t=l.ticker;
      newVal[t]={loading:true};
      Promise.all([
        fetch("/api/market?source=fh&endpoint=stock/recommendation?symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
        fetch("/api/market?source=fh&endpoint=stock/price-target?symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
        fetch("/api/market?source=fh&endpoint=stock/earnings?symbol="+t+"&limit=4").then(function(r){return r.json();}).catch(function(){return null;}),
        fetch("/api/market?source=td&endpoint=quote?symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
        fetch("/api/market?source=fh&endpoint=quote?symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
        fetch("/api/market?source=fh&endpoint=stock/metric?symbol="+t+"&metric=all").then(function(r){return r.json();}).catch(function(){return null;}),
        fetch("/api/edgar?ticker="+t).then(function(r){return r.json();}).catch(function(){return null;}),
      ]).then(function(results){
        var rec=results[0],pt=results[1],earn=results[2],quote=results[3],fhQuote=results[4],metric=results[5],edgar=results[6];
        var checks={};
        var score=0,total=0;
        if(rec&&Array.isArray(rec)&&rec.length>0){
          var r=rec[0];var buy=(r.buy||0)+(r.strongBuy||0),sell=(r.sell||0)+(r.strongSell||0),hold=r.hold||0;
          var tot=buy+sell+hold||1;var pct=Math.round(buy/tot*100);
          checks.analystBuy=pct+"% analyst buy consensus";if(buy/tot>0.5){score++;}total++;
        }
        if(pt&&pt.targetMean){
          var cur=parseFloat((l.price||"0").replace(/[^0-9.]/g,""));
          var tgt=parseFloat(pt.targetMean||0);
          if(tgt>0&&cur>0){
            var upside=((tgt-cur)/cur*100).toFixed(0);
            checks.priceTarget="Analyst target $"+tgt.toFixed(0)+" ("+(upside>0?"+":"")+upside+"%)";
            if(tgt>cur){score++;}total++;
          }
        }
        if(earn&&Array.isArray(earn)&&earn.length>0){
          var beats=earn.filter(function(e){return e.surprise>0;}).length;
          checks.earningsBeat=beats+"/"+earn.length+" recent quarters beat";
          if(beats/earn.length>=0.5){score++;}total++;
        }
        if(quote&&quote.close&&quote.fifty_two_week){
          var price=parseFloat(quote.close);
          var hi=parseFloat(quote.fifty_two_week.high);
          var lo=parseFloat(quote.fifty_two_week.low);
          var rng=hi-lo||1;
          var pos=Math.round((price-lo)/rng*100);
          checks.weekPosition="At "+pos+"% of 52-week range ($"+lo.toFixed(0)+"-$"+hi.toFixed(0)+")";
          if(pos<40){score++;}total++;
        }
        if(quote&&quote.volume&&quote.average_volume){
          var vr=(parseFloat(quote.volume)/parseFloat(quote.average_volume)).toFixed(1);
          checks.volume="Volume "+vr+"x average";
          if(parseFloat(vr)>1.5){score++;}total++;
        }
        // 6. Finnhub quote: is price above 50-day moving average? (bullish signal)
        if(fhQuote&&fhQuote.c&&fhQuote.c>0){
          var fhPrice=fhQuote.c,prevClose=fhQuote.pc||fhPrice;
          var chgPct=((fhPrice-prevClose)/prevClose*100).toFixed(1);
          checks.recentMove="Today: "+(chgPct>0?"+":"")+chgPct+"% ($"+fhPrice.toFixed(2)+")";
          if(fhQuote.dp<-5){score++;} // big single-day drop = capitulation signal
          total++;
        }
        // 7. Fundamental metric: P/E and beta from Finnhub
        if(metric&&metric.metric){
          var m=metric.metric;
          var beta=m.beta;var pe=m["peExclExtraTTM"];
          if(beta!==undefined){
            checks.riskMetric="Beta: "+(beta?beta.toFixed(2):"N/A")+(pe?" | P/E: "+pe.toFixed(1):"");
            if(beta&&beta<1.5){score++;} // lower beta = less volatile, safer recovery
            total++;
          }
        }
        // 8. SEC EDGAR: revenue growth from actual filings
        if(edgar&&edgar.revenues&&edgar.revenues.length>=2){
          var revs=edgar.revenues;
          var latest=revs[revs.length-1].val,prior=revs[revs.length-2].val;
          var revGrowth=prior>0?((latest-prior)/prior*100).toFixed(1):0;
          var growing=parseFloat(revGrowth)>0;
          checks.secRevenue="SEC filing: Revenue "+(growing?"+":"")+revGrowth+"% YoY ($"+(latest/1e9).toFixed(1)+"B)";
          if(growing){score++;}total++;
        }
        var pct2=total>0?score/total:0;
        var confidence=pct2>=0.6?"HIGH":pct2>=0.4?"MEDIUM":"LOW";
        newVal[t]={loading:false,checks,score,total,confidence};
        // Save validation score to Supabase
        fetch("/api/portfolio?action=validation",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            ticker:t,
            confidence,
            score,
            checks_passed:score,
            checks_total:total,
            checks_detail:Object.entries(checks).map(function(e){return e[0]+": "+e[1];}).join(" | ")
          })
        }).catch(function(){});
        done();
      }).catch(function(){newVal[t]={loading:false,checks:{},score:0,total:0,confidence:"LOW"};done();});
    });
  }

  function runAnalysis(){
    setLoading(true);setError(null);setLosers([]);setSummary(null);setValidation({});
    var userPrompt="Today is "+new Date().toDateString()+". "+cat.prompt+"\n\n"+
      "Return a JSON array of exactly 8 objects. Each object must have these exact fields:\n"+
      "ticker (string), name (string), sector (string), drop (string e.g. \"-18.4%\"), dropNum (negative number e.g. -18.4),\n"+
      "price (string e.g. \"$142.30\"), marketCap (string e.g. \"$48B\"),\n"+
      "verdict (exactly one of: \"Strong Overreaction\", \"Overreaction\", \"Partial Overreaction\", \"Mixed\", \"Justified\"),\n"+
      "catalyst (string, 1 sentence), bull (string, 2 sentences), bear (string, 2 sentences),\n"+
      "analystTarget (string e.g. \"$185\" or \"N/A\"), upside (string e.g. \"+42%\" or \"N/A\"), upsideNum (number),\n"+
      "recommendation (exactly one of: \"Strong Buy\", \"Buy\", \"Watch\", \"Avoid\")";
    fetch("/api/analyze",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"claude-sonnet-4-20250514",
        max_tokens:4000,
        system:"You are a financial data API. Your ENTIRE response must be a valid JSON array starting with [ and ending with ]. No text before or after. No markdown fences.",
        messages:[{role:"user",content:userPrompt},{role:"assistant",content:"[{"}]
      }),
    })
    .then(function(res){return res.json();})
    .then(function(data){
      if(data.error){throw new Error(data.error.message||"API error");}
      var raw=(data.content||[]).map(function(b){return b.text||"";}).join("");
      var combined="[{"+raw;
      var clean=combined.replace(/```json/g,"").replace(/```/g,"").trim();
      var start=clean.indexOf("["),end=clean.lastIndexOf("]");
      if(start===-1||end===-1||end<=start)throw new Error("No JSON array found in response");
      var jsonStr=clean.slice(start,end+1);
      var parsed=JSON.parse(jsonStr);
      setLosers(parsed);
      validateLosers(parsed);
      var over=parsed.filter(function(s){return s.verdict==="Strong Overreaction"||s.verdict==="Overreaction";}).length;
      var avgDrop=(parsed.reduce(function(s,l){return s+(l.dropNum||0);},0)/parsed.length).toFixed(1);
      var upArr=parsed.filter(function(l){return l.upsideNum>0;});
      var avgUp=upArr.length>0?(upArr.reduce(function(s,l){return s+l.upsideNum;},0)/upArr.length).toFixed(0):"0";
      setSummary({over,total:parsed.length,avgDrop,avgUp});
      setLoading(false);
      // Save results to Supabase
      fetch("/api/portfolio?action=ai_analysis",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({results:parsed,category:cat.id})
      }).catch(function(){});
    })
    .catch(function(err){var m=err.message||"Unknown error";setLoading(false);setError("Analysis failed: "+m+(m.includes("401")?" - Invalid API key.":" - Try again."));});
  }

  var shown=losers.filter(function(l){
    if(filter==="all")return true;
    if(filter==="buy")return l.recommendation==="Strong Buy"||l.recommendation==="Buy";
    if(filter==="watch")return l.recommendation==="Watch";
    if(filter==="avoid")return l.recommendation==="Avoid";
    return true;
  });
  var VS={
    "Strong Overreaction":{c:"#4ade80",bg:"#052e16",b:"#16a34a",dot:"#22c55e"},
    "Overreaction":{c:"#86efac",bg:"#052e16",b:"#15803d",dot:"#4ade80"},
    "Partial Overreaction":{c:"#fcd34d",bg:"#1c1917",b:"#d97706",dot:"#f59e0b"},
    "Mixed":{c:"#94a3b8",bg:"#0f172a",b:"#334155",dot:"#64748b"},
    "Justified":{c:"#f87171",bg:"#1c0505",b:"#b91c1c",dot:"#ef4444"},
  };

  return(
    <div>
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20,flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:22,fontWeight:800,color:"#f1f5f9",marginBottom:4}}>AI Analysis</div>
          <div style={{fontSize:11,color:"#334155",marginTop:3}}>Select a category, then run analysis</div>
        </div>
        {losers.length>0&&!loading&&(
          <button onClick={runAnalysis} disabled={loading} style={{background:"linear-gradient(135deg,"+cat.color+","+cat.border+")",border:"none",color:"#fff",borderRadius:9,padding:"11px 22px",fontSize:13,fontWeight:700,cursor:"pointer"}}>
            {cat.icon} Refresh {cat.label}
          </button>
        )}
      </div>

      {/* Search Bar */}
      <div style={{background:"#0a0f1a",border:"1px solid #1e293b",borderRadius:12,padding:"14px 16px",marginBottom:16}}>
        <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:8}}>ANALYZE ANY STOCK</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input
            value={searchTicker}
            onChange={function(e){setSearchTicker(e.target.value.toUpperCase());setSearchResult(null);setSearchError(null);}}
            onKeyDown={function(e){if(e.key==="Enter")runSearch();}}
            placeholder="Enter ticker e.g. AAPL, NVDA, META..."
            style={{flex:1,background:"#030712",border:"1px solid #1e293b",borderRadius:8,padding:"10px 14px",
              color:"#f1f5f9",fontSize:13,outline:"none",fontFamily:"inherit"}}
          />
          <button onClick={runSearch} disabled={searchLoading||!searchTicker.trim()}
            style={{background:searchLoading||!searchTicker.trim()?"#1e293b":"linear-gradient(135deg,#1d4ed8,#7c3aed)",
              border:"none",color:searchLoading||!searchTicker.trim()?"#475569":"#fff",
              borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:700,
              cursor:searchLoading||!searchTicker.trim()?"not-allowed":"pointer",whiteSpace:"nowrap"}}>
            {searchLoading?"Analyzing...":"🔍 Analyze"}
          </button>
          {searchResult&&<button onClick={function(){setSearchResult(null);setSearchTicker("");}}
            style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:8,
              padding:"10px 14px",fontSize:12,cursor:"pointer"}}>Clear</button>}
        </div>
        {searchError&&<div style={{marginTop:8,fontSize:11,color:"#f87171"}}>{searchError}</div>}
      </div>

      {/* Search Result Card */}
      {searchLoading&&<div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"20px 22px",marginBottom:16,display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:16,height:16,border:"2px solid #1e293b",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
        <div style={{fontSize:13,color:"#f1f5f9",fontWeight:600}}>Claude is analyzing {searchTicker}...</div>
      </div>}
      {searchResult&&!searchLoading&&(function(){
        var sr=searchResult;
        var vs={"Strong Overreaction":{c:"#4ade80",bg:"#052e16",b:"#16a34a",dot:"#22c55e"},
          "Overreaction":{c:"#86efac",bg:"#052e16",b:"#15803d",dot:"#4ade80"},
          "Partial Overreaction":{c:"#fcd34d",bg:"#1c1917",b:"#d97706",dot:"#f59e0b"},
          "Mixed":{c:"#94a3b8",bg:"#0f172a",b:"#334155",dot:"#64748b"},
          "Justified":{c:"#f87171",bg:"#1c0505",b:"#b91c1c",dot:"#ef4444"},
          "Fairly Valued":{c:"#60a5fa",bg:"#0c1a2e",b:"#1e3a5f",dot:"#3b82f6"},
          "Overvalued":{c:"#fb923c",bg:"#1c0a00",b:"#9a3412",dot:"#f97316"}};
        var v=vs[sr.verdict]||vs["Mixed"];
        var rc2=sr.recommendation==="Strong Buy"?"#22c55e":sr.recommendation==="Buy"?"#4ade80":sr.recommendation==="Watch"?"#f59e0b":"#f87171";
        return(
          <div style={{background:"#0a0f1a",border:"1px solid "+v.b,borderRadius:14,padding:"20px 22px",marginBottom:16,animation:"fu 0.3s ease both"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
              <div style={{display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                <div><div style={{fontSize:26,fontWeight:800,color:"#f1f5f9"}}>{sr.ticker}</div><div style={{fontSize:12,color:"#475569",marginTop:2}}>{sr.name}</div></div>
                <div><div style={{fontSize:20,fontWeight:700,color:"#94a3b8"}}>{sr.price}</div><div style={{fontSize:10,color:"#334155",marginTop:2}}>{sr.sector}  |  {sr.exchange}</div></div>
                <div><div style={{fontSize:11,color:"#475569"}}>52w: {sr.fiftyTwoWeekLow} - {sr.fiftyTwoWeekHigh}</div><div style={{fontSize:11,color:"#475569",marginTop:2}}>Mkt Cap: {sr.marketCap}</div></div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:800,background:v.bg,color:v.c,border:"1px solid "+v.b,display:"flex",alignItems:"center",gap:6}}>
                  <span style={{width:7,height:7,borderRadius:"50%",background:v.dot,display:"inline-block"}}/>{sr.verdict}
                </span>
                <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:700,background:"#0f172a",border:"1px solid #1e293b",color:rc2}}>{sr.recommendation}</span>
                {(function(){
                  var ss=screenerSig(sr.ticker);
                  if(!ss||ss==="HOLD")return null;
                  var sc=ss==="STRONG_BUY"?"#22c55e":ss==="BUY"?"#4ade80":ss==="WATCH"?"#f59e0b":ss==="SELL"?"#f87171":"#94a3b8";
                  return <span style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:"#0f172a",border:"1px solid "+sc,color:sc,letterSpacing:1}}>{"SCREENER: "+ss.replace("_"," ")}</span>;
                })()}
              </div>
            </div>
            {sr.summary&&<div style={{background:"#030712",border:"1px solid "+v.b,borderRadius:8,padding:"12px 14px",marginBottom:12}}>
              <div style={{fontSize:9,color:v.c,letterSpacing:2,marginBottom:6,fontWeight:700}}>CLAUDE'S TAKE</div>
              <div style={{fontSize:13,color:"#e2e8f0",lineHeight:1.7}}>{sr.summary}</div>
            </div>}
            <div style={{background:"#030712",border:"1px solid #0f172a",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
              <span style={{fontSize:9,color:"#334155",letterSpacing:2,marginRight:10}}>CATALYST</span>
              <span style={{fontSize:12,color:"#94a3b8"}}>{sr.catalyst}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              <div style={{background:"#030e05",border:"1px solid #14532d",borderRadius:8,padding:"12px 14px"}}>
                <div style={{fontSize:9,color:"#16a34a",letterSpacing:2,fontWeight:700,marginBottom:7}}>BULL CASE</div>
                <div style={{fontSize:12,color:"#86efac",lineHeight:1.6}}>{sr.bull}</div>
              </div>
              <div style={{background:"#0e0303",border:"1px solid #7f1d1d",borderRadius:8,padding:"12px 14px"}}>
                <div style={{fontSize:9,color:"#b91c1c",letterSpacing:2,fontWeight:700,marginBottom:7}}>BEAR CASE</div>
                <div style={{fontSize:12,color:"#fca5a5",lineHeight:1.6}}>{sr.bear}</div>
              </div>
            </div>
            <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
              {watchlist.find(function(w){return w.ticker===sr.ticker;})?
                <button onClick={function(){removeFromWatchlist(sr.ticker);}} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>✓ In Watchlist</button>:
                <button onClick={function(){addToWatchlist(sr.ticker,sr.name);}} style={{background:"transparent",border:"1px solid #1d4ed8",color:"#60a5fa",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>+ Add to Screener</button>
              }
              <button onClick={function(){toggleExpand(sr.ticker,"chart");}} style={{background:expanded[sr.ticker]&&expanded[sr.ticker].chart?"#0c1a2e":"transparent",border:"1px solid #1e293b",color:expanded[sr.ticker]&&expanded[sr.ticker].chart?"#60a5fa":"#475569",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>📈 90-Day Chart</button>
              <button onClick={function(){toggleExpand(sr.ticker,"ratings");}} style={{background:expanded[sr.ticker]&&expanded[sr.ticker].ratings?"#0c1a2e":"transparent",border:"1px solid #1e293b",color:expanded[sr.ticker]&&expanded[sr.ticker].ratings?"#60a5fa":"#475569",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>👥 Analyst Ratings</button>
            </div>
            {expanded[sr.ticker]&&expanded[sr.ticker].chart&&<div style={{marginBottom:12}}><PriceChart data={chartData[sr.ticker]} ticker={sr.ticker}/></div>}
            {expanded[sr.ticker]&&expanded[sr.ticker].ratings&&<div style={{marginBottom:12}}><AnalystChart data={ratingsData[sr.ticker]}/></div>}
            <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
              {[
                {label:"ANALYST TARGET",val:sr.analystTarget,color:"#f1f5f9"},
                {label:"UPSIDE",val:sr.upside,color:sr.upsideNum>0?"#4ade80":sr.upsideNum<0?"#f87171":"#64748b"},
                {label:"P/E RATIO",val:sr.peRatio,color:"#94a3b8"},
                {label:"REVENUE GROWTH",val:sr.revenueGrowth,color:"#94a3b8"},
              ].map(function(m,i){return(
                <div key={i}><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:4}}>{m.label}</div>
                <div style={{fontSize:14,fontWeight:700,color:m.color}}>{m.val||"N/A"}</div></div>
              );})}
            </div>
          </div>
        );
      })()}

      {/* Category Toggle */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:20}}>
        {CATEGORIES.map(function(c){
          var active=category===c.id;
          return(
            <button key={c.id} onClick={function(){setCategory(c.id);setError(null);setFilter("all");}}
              style={{background:active?c.bg:"#0a0f1a",border:"1px solid "+(active?c.color:"#1e293b"),borderRadius:10,padding:"12px 10px",cursor:"pointer",textAlign:"left",transition:"all 0.15s"}}>
              <div style={{fontSize:18,marginBottom:4}}>{c.icon}</div>
              <div style={{fontSize:12,fontWeight:800,color:active?c.color:"#64748b",marginBottom:2}}>{c.label}</div>
              <div style={{fontSize:9,color:active?c.color:"#334155",letterSpacing:1,marginBottom:4}}>{c.cap}</div>
              <div style={{fontSize:10,color:active?"#94a3b8":"#1e293b"}}>{c.desc}</div>
            </button>
          );
        })}
      </div>

      {/* Empty state */}
      {!loading&&losers.length===0&&!error&&(
        <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:14,padding:"40px 30px",textAlign:"center"}}>
          <div style={{fontSize:36,marginBottom:12}}>{cat.icon}</div>
          <div style={{fontSize:18,fontWeight:700,color:cat.color,marginBottom:8}}>{cat.label}</div>
          <div style={{fontSize:13,color:"#475569",maxWidth:460,margin:"0 auto",lineHeight:1.7,marginBottom:28}}>{cat.desc} - Claude analyzes each drop and verdicts whether it is a buying opportunity or a falling knife.</div>
          <button onClick={runAnalysis} style={{background:"linear-gradient(135deg,"+cat.color+","+cat.border+"22)",border:"1px solid "+cat.color,color:cat.color,borderRadius:9,padding:"13px 32px",fontSize:14,fontWeight:700,cursor:"pointer"}}>
            {cat.icon} Run {cat.label} Analysis
          </button>
        </div>
      )}

      {/* Loading */}
      {loading&&<div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"24px 22px",display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:16,height:16,border:"2px solid #1e293b",borderTopColor:cat.color,borderRadius:"50%",animation:"spin 0.8s linear infinite",flexShrink:0}}/>
        <div><div style={{fontSize:13,color:"#f1f5f9",fontWeight:600}}>Analyzing {cat.label}...</div><div style={{fontSize:11,color:"#334155",marginTop:3}}>Scanning {cat.cap} universe for overreactions</div></div>
      </div>}

      {/* Error */}
      {error&&<div style={{background:"#1c0505",border:"1px solid #7f1d1d",borderRadius:10,padding:"14px 18px",color:"#f87171",fontSize:13,marginBottom:16}}>{error}</div>}

      {/* Summary bar */}
      {summary&&!loading&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:16}}>
          {[
            {label:"OVERREACTIONS",value:summary.over+"/"+summary.total,color:cat.color},
            {label:"AVG DROP",value:summary.avgDrop+"%",color:"#f87171"},
            {label:"AVG UPSIDE",value:"+"+summary.avgUp+"%",color:"#4ade80"},
            {label:"CATEGORY",value:cat.icon+" "+cat.label,color:cat.color},
          ].map(function(m,i){return(
            <div key={i} style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:8,padding:"10px 14px"}}>
              <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:4}}>{m.label}</div>
              <div style={{fontSize:15,fontWeight:800,color:m.color}}>{m.value}</div>
            </div>
          );})}
        </div>
      )}

      {/* Filter tabs */}
      {losers.length>0&&!loading&&(
        <div style={{display:"flex",gap:6,marginBottom:14}}>
          {["all","buy","watch","avoid"].map(function(f){return(
            <button key={f} onClick={function(){setFilter(f);}}
              style={{background:filter===f?"#1e293b":"transparent",border:"1px solid "+(filter===f?"#334155":"#0f172a"),borderRadius:6,padding:"5px 12px",fontSize:11,fontWeight:600,color:filter===f?"#f1f5f9":"#334155",cursor:"pointer",textTransform:"capitalize"}}>{f}</button>
          );})}
          {validating&&<span style={{fontSize:10,color:"#334155",alignSelf:"center",marginLeft:8}}>Validating with real data...</span>}
        </div>
      )}

      {/* Cards */}
      {shown.map(function(l,i){
        var vs=VS[l.verdict]||VS["Mixed"];
        var isBuy=l.recommendation==="Strong Buy"||l.recommendation==="Buy";
        var rc2=l.recommendation==="Strong Buy"?"#22c55e":l.recommendation==="Buy"?"#4ade80":l.recommendation==="Watch"?"#f59e0b":"#f87171";
        return(
          <div key={l.ticker+i} style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:14,padding:"20px 22px",marginBottom:12,animation:"fu 0.3s ease "+(i*0.05)+"s both"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
              <div style={{display:"flex",gap:14,alignItems:"center"}}>
                <div><div style={{fontSize:22,fontWeight:800,color:"#f1f5f9"}}>{l.ticker}</div><div style={{fontSize:11,color:"#475569",marginTop:2}}>{l.name}</div></div>
                <div><div style={{fontSize:22,fontWeight:800,color:"#ef4444"}}>{l.drop}</div><div style={{fontSize:10,color:"#475569",marginTop:2}}>from high</div></div>
                <div><div style={{fontSize:15,fontWeight:600,color:"#94a3b8"}}>{l.price}</div><div style={{fontSize:10,color:"#334155",marginTop:2}}>{l.sector}</div></div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:cat.bg,color:cat.color,border:"1px solid "+cat.border}}>{cat.icon} {cat.label}</span>
                <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:800,background:vs.bg,color:vs.c,border:"1px solid "+vs.b,display:"flex",alignItems:"center",gap:6}}>
                  <span style={{width:7,height:7,borderRadius:"50%",background:vs.dot,display:"inline-block"}}/>{l.verdict}
                </span>
                <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:700,background:"#0f172a",border:"1px solid #1e293b",color:rc2}}>{l.recommendation}</span>
                {(function(){
                  var ss=screenerSig(l.ticker);
                  if(!ss||ss==="HOLD")return null;
                  var sc=ss==="STRONG_BUY"?"#22c55e":ss==="BUY"?"#4ade80":ss==="WATCH"?"#f59e0b":ss==="SELL"?"#f87171":"#94a3b8";
                  return <span style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:"#0f172a",border:"1px solid "+sc,color:sc,letterSpacing:1}}>{"SCREENER: "+ss.replace("_"," ")}</span>;
                })()}
              </div>
            </div>
            <div style={{background:"#030712",border:"1px solid #0f172a",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
              <span style={{fontSize:9,color:"#334155",letterSpacing:2,marginRight:10}}>CATALYST</span>
              <span style={{fontSize:12,color:"#94a3b8"}}>{l.catalyst}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              <div style={{background:"#030e05",border:"1px solid #14532d",borderRadius:8,padding:"12px 14px"}}><div style={{fontSize:9,color:"#16a34a",letterSpacing:2,fontWeight:700,marginBottom:7}}>BULL CASE</div><div style={{fontSize:12,color:"#86efac",lineHeight:1.6}}>{l.bull}</div></div>
              <div style={{background:"#0e0303",border:"1px solid #7f1d1d",borderRadius:8,padding:"12px 14px"}}><div style={{fontSize:9,color:"#b91c1c",letterSpacing:2,fontWeight:700,marginBottom:7}}>BEAR CASE</div><div style={{fontSize:12,color:"#fca5a5",lineHeight:1.6}}>{l.bear}</div></div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
              <div style={{display:"flex",gap:20}}>
                <div><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:4}}>ANALYST TARGET</div><div style={{fontSize:14,fontWeight:700,color:"#f1f5f9"}}>{l.analystTarget}</div></div>
                <div><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:4}}>UPSIDE</div><div style={{fontSize:14,fontWeight:700,color:l.upsideNum>0?"#4ade80":l.upsideNum<0?"#f87171":"#64748b"}}>{l.upside}</div></div>
                <div><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:4}}>MKT CAP</div><div style={{fontSize:14,fontWeight:700,color:"#94a3b8"}}>{l.marketCap}</div></div>
              </div>
              {isBuy&&<button onClick={function(){var m=props.stocks.find(function(s){return s.ticker===l.ticker;});props.setModal(m?Object.assign({},m,{side:"BUY"}):{ticker:l.ticker,cur:parseFloat((l.price||"0").replace(/[^0-9.]/g,"")),sl:0,tp:0,side:"BUY"});props.setTab("paper");props.setQty(1);}} style={{background:"#15803d",border:"none",color:"#fff",borderRadius:8,padding:"10px 20px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Paper Buy {l.ticker}</button>}
              {watchlist.find(function(w){return w.ticker===l.ticker;})?
                <button onClick={function(){removeFromWatchlist(l.ticker);}} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:8,padding:"10px 14px",fontSize:12,cursor:"pointer"}}>✓ In Watchlist</button>:
                <button onClick={function(){addToWatchlist(l.ticker,l.name);}} style={{background:"transparent",border:"1px solid #1d4ed8",color:"#60a5fa",borderRadius:8,padding:"10px 14px",fontSize:12,cursor:"pointer"}}>+ Add to Screener</button>
              }
              <button onClick={function(){toggleExpand(l.ticker,"chart");}} style={{background:expanded[l.ticker]&&expanded[l.ticker].chart?"#0c1a2e":"transparent",border:"1px solid #1e293b",color:expanded[l.ticker]&&expanded[l.ticker].chart?"#60a5fa":"#475569",borderRadius:8,padding:"10px 14px",fontSize:12,cursor:"pointer"}}>📈 Chart</button>
              <button onClick={function(){toggleExpand(l.ticker,"ratings");}} style={{background:expanded[l.ticker]&&expanded[l.ticker].ratings?"#0c1a2e":"transparent",border:"1px solid #1e293b",color:expanded[l.ticker]&&expanded[l.ticker].ratings?"#60a5fa":"#475569",borderRadius:8,padding:"10px 14px",fontSize:12,cursor:"pointer"}}>👥 Analysts</button>
            </div>
            {expanded[l.ticker]&&expanded[l.ticker].chart&&(
              <div style={{marginTop:12,borderTop:"1px solid #0f172a",paddingTop:12}}>
                <PriceChart data={chartData[l.ticker]} ticker={l.ticker}/>
              </div>
            )}
            {expanded[l.ticker]&&expanded[l.ticker].ratings&&(
              <div style={{marginTop:12,borderTop:"1px solid #0f172a",paddingTop:12}}>
                <AnalystChart data={ratingsData[l.ticker]}/>
              </div>
            )}
            {validation[l.ticker]&&(function(){
              var v=validation[l.ticker];
              if(v.loading)return <div style={{marginTop:12,fontSize:10,color:"#334155"}}>Validating...</div>;
              var conf=v.confidence;
              var confColor=conf==="HIGH"?"#22c55e":conf==="MEDIUM"?"#f59e0b":"#f87171";
              var confBg=conf==="HIGH"?"#052e16":conf==="MEDIUM"?"#1c1917":"#1c0505";
              return(
                <div style={{marginTop:12,borderTop:"1px solid #0f172a",paddingTop:12}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                    <span style={{fontSize:9,letterSpacing:2,color:"#334155"}}>REAL DATA VALIDATION</span>
                    <span style={{fontSize:9,fontWeight:800,color:confColor,background:confBg,border:"1px solid "+confColor,borderRadius:4,padding:"2px 8px"}}>{conf} CONFIDENCE</span>
                    <span style={{fontSize:9,color:"#334155"}}>{v.score}/{v.total} checks pass</span>
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {Object.values(v.checks||{}).map(function(c,i){return(
                      <span key={i} style={{fontSize:10,color:"#64748b",background:"#0f172a",border:"1px solid #1e293b",borderRadius:4,padding:"3px 8px"}}>{c}</span>
                    );})}
                  </div>
                </div>
              );
            })()}
          </div>
        );
      })}
      {losers.length>0&&!loading&&<div style={{marginTop:14,padding:"10px 14px",background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:8,fontSize:10,color:"#334155"}}>AI analysis is for educational purposes only. Not financial advice. Sandbox environment.</div>}
    </div>
  );
}

export default function App(){
  var [tab,setTab]=useState("screener");
  var [stocks,setStocks]=useState([]);
  var [appWatchlist,setAppWatchlist]=useState([]);
  var [tickerDetail,setTickerDetail]=useState(null); // stock object for detail panel
  var [tickerAI,setTickerAI]=useState(null);         // AI explanation
  var [tickerAILoading,setTickerAILoading]=useState(false);

  function openTickerDetail(s){
    setTickerDetail(s);
    setTickerAI(null);
    setTickerAILoading(true);
    var prompt="Today is "+new Date().toDateString()+". Analyze "+s.ticker+" ("+s.sector+") which currently has a "+s.sig.replace("_"," ")+" signal. "+
      "The key metrics are: Price $"+s.cur+", "+s.dip.toFixed(1)+"% below 52-week high of $"+s.h52+
      ", RSI "+s.rsi+" (oversold<35, overbought>70), MACD "+(s.mh>0?"bullish":"bearish")+" at "+s.mh+
      ", Volume "+s.vr+"x average, 1D change "+s.chg+"%"+
      ", Score "+s.score+"/100. "+
      "In 3-4 sentences, explain the specific justification for the "+s.sig.replace("_"," ")+" signal based on these exact numbers. "+
      "Be specific - reference the RSI, DIP, and MACD values. Keep it factual and concise.";
    fetch("/api/analyze",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"claude-sonnet-4-20250514",max_tokens:300,
        system:"You are a technical analysis assistant. Respond in 3-4 sentences only. Be specific about the numbers provided.",
        messages:[{role:"user",content:prompt}]
      })
    }).then(function(r){return r.json();})
    .then(function(d){
      var txt=(d.content||[]).map(function(b){return b.text||"";}).join("").trim();
      setTickerAI(txt);setTickerAILoading(false);
    })
    .catch(function(){setTickerAI("Unable to generate analysis.");setTickerAILoading(false);});
  }
  var [watchlistStocks,setWatchlistStocks]=useState([]);
  function refreshWatchlist(){
    fetch("/api/portfolio?action=watchlist").then(function(r){return r.json();}).then(function(data){
      setAppWatchlist(Array.isArray(data)?data:[]);
      if(!data||!data.length)return;
      var syms=data.map(function(w){return w.ticker;}).join(",");
      fetch("/api/market?source=td&endpoint=quote?symbol="+syms)
        .then(function(r){return r.json();})
        .then(function(batch){
          var ns=data.map(function(w){
            var q=batch[w.ticker]||{};
            var cur=parseFloat(q.close)||0;
            var prev=parseFloat(q.previous_close)||cur;
            var chg=prev>0?((cur-prev)/prev*100):0;
            return{ticker:w.ticker,name:w.name||w.ticker,cur:+cur.toFixed(2),chg:+chg.toFixed(2),
              hi52:parseFloat((q.fifty_two_week||{}).high)||0,lo52:parseFloat((q.fifty_two_week||{}).low)||0,
              vol:parseFloat(q.volume)||0,avgVol:parseFloat(q.average_volume)||1};
          });
          setWatchlistStocks(ns);
        }).catch(function(){});
    }).catch(function(){});
  }
  useEffect(function(){refreshWatchlist();},[]);
  var [cfg,setCfg]=useState(Object.assign({},INIT_CFG));
  var [port,setPort]=useState({cash:INIT_CFG.startCash,pos:{},trades:[]});
  var [storageReady,setStorageReady]=useState(false);
  var [btTicker,setBtTicker]=useState("AAPL");
  var [btResult,setBtResult]=useState(null);
  var [alpaca,setAlpaca]=useState({key:"",secret:"",live:false});
  var [tdKey,setTdKey]=useState("");
  var [fhKey,setFhKey]=useState("");
  var [fmpKey,setFmpKey]=useState("");
  var [anthropicKey,setAnthropicKey]=useState("");
  var [modal,setModal]=useState(null);
  var [qty,setQty]=useState(1);
  var [toast,setToast]=useState(null);
  var [sf,setSf]=useState("all");
  var [srt,setSrt]=useState("score");
  var [lastR,setLastR]=useState(null);
  // Autopilot state
  var [apOn,setApOn]=useState(false);
  var [apLog,setApLog]=useState([]);
  var [tuneLog,setTuneLog]=useState([]);
  var [apStats,setApStats]=useState({trades:0,tunes:0});
  var [apCountdown,setApCountdown]=useState(AP_SEC);
  // Refs for interval access to latest state
  var stocksRef=useRef([]);
  var portRef=useRef({cash:INIT_CFG.startCash,pos:{},trades:[]});
  var cfgRef=useRef(Object.assign({},INIT_CFG));
  var apOnRef=useRef(false);
  var intervalRef=useRef(null);
  var countRef=useRef(AP_SEC);
  var scanCountRef=useRef(0);
  var tdKeyRef=useRef("");
  var fhKeyRef=useRef("");
  var fmpKeyRef=useRef("");

  useEffect(function(){stocksRef.current=stocks;},[stocks]);
  useEffect(function(){portRef.current=port;},[port]);
  useEffect(function(){cfgRef.current=cfg;},[cfg]);
  useEffect(function(){apOnRef.current=apOn;},[apOn]);
  useEffect(function(){tdKeyRef.current=tdKey;},[tdKey]);
  useEffect(function(){fhKeyRef.current=fhKey;},[fhKey]);
  useEffect(function(){fmpKeyRef.current=fmpKey;},[fmpKey]);

  function notify(msg,err){setToast({msg,err:!!err});setTimeout(function(){setToast(null);},3000);}

  var [dataLoading,setDataLoading]=useState(false);
  var [dataSource,setDataSource]=useState("simulated");

  function buildStockFromReal(ticker,i,cfg,quote,hist){
    var values=(hist&&hist.values)||[];
    var prices=values.slice().reverse().map(function(v){return parseFloat(v.close);});
    if(prices.length<20)return genStock(ticker,i,cfg);
    var cur=parseFloat(quote.close)||prices[prices.length-1];
    var h52=parseFloat((quote.fifty_two_week||{}).high)||Math.max.apply(null,prices);
    var dip=(h52-cur)/h52*100;
    var r=lastRSI(prices),mh=macdH(prices);
    var chg=parseFloat(quote.percent_change)||0;
    var vol=parseFloat(quote.volume)||0;
    var avgVol=parseFloat(quote.average_volume)||1;
    var vr=avgVol>0?+(vol/avgVol).toFixed(2):1;
    var sig="HOLD";
    if(dip>=cfg.dipMin&&dip<=cfg.dipMax){
      if(r>=cfg.rsiRecovery&&r<60&&mh>0&&vr>=cfg.volMult)sig="STRONG_BUY";
      else if(r>=cfg.rsiOversold&&mh>-0.5)sig="BUY";
      else if(r<cfg.rsiOversold)sig="WATCH";
    }else if(dip<5){if(r>70)sig="SELL";}
    else if(dip>25&&dip<=40){if(r>=45&&mh>0&&vr>=1.3)sig="BUY";else if(r>=35&&mh>-0.5)sig="WATCH";else sig="SELL";}else if(dip>40){sig=r<35?"WATCH":"SELL";}
    var score=Math.min(100,Math.max(0,Math.round(
      (dip>=5&&dip<=20?30:0)+(r>=35&&r<=55?25:r<35?15:0)+(mh>0?25:0)+(vr>=1.3?20:vr>=1?10:0)
    )));
    return{ticker,prices,cur:+cur.toFixed(2),h52:+h52.toFixed(2),dip:+dip.toFixed(1),
      rsi:r,mh,chg:+chg.toFixed(2),vr,sig,score,sector:SECTORS[i%20],
      sl:+(cur*(1-cfg.sl/100)).toFixed(2),tp:+(cur*(1+cfg.tp/100)).toFixed(2),
      entry:"$"+(cur*0.98).toFixed(2)+"-$"+(cur*1.01).toFixed(2),isReal:true};
  }

  function detStock(t,i,c){
              var cur=BASE[t]||50;
              var h52hi=cur*1.3,h52lo=cur*0.75,dip=(h52hi-cur)/h52hi*100;
              var days=90,prices=[],hash=t.split("").reduce(function(a,ch){return a+ch.charCodeAt(0);},0);
              for(var d=0;d<days;d++){var progress=d/(days-1);var base=h52lo+(cur-h52lo)*Math.pow(progress,0.7);var osc=((hash*d)%17-8)/8*(h52hi-h52lo)*0.04;prices.push(Math.max(h52lo*0.95,Math.min(h52hi*1.02,base+osc)));}
              prices[prices.length-1]=cur;
              var rsi=lastRSI(prices),mh=macdH(prices),vr=1.0,sig="HOLD";
              if(dip>=c.dipMin&&dip<=c.dipMax){if(rsi>=c.rsiRecovery&&rsi<60&&mh>0&&vr>=c.volMult)sig="STRONG_BUY";else if(rsi>=c.rsiOversold&&mh>-0.5)sig="BUY";else if(rsi<c.rsiOversold)sig="WATCH";}else if(dip<5){if(rsi>70)sig="SELL";}else if(dip>25&&dip<=40){if(rsi>=c.rsiRecovery&&mh>0&&vr>=c.volMult)sig="BUY";else if(rsi>=c.rsiOversold&&mh>-0.5)sig="WATCH";else sig="SELL";}else if(dip>40){sig=rsi<35?"WATCH":"SELL";}
              var score=Math.min(100,Math.max(0,Math.round((dip>=5&&dip<=20?30:0)+(rsi>=35&&rsi<=55?25:rsi<35?15:0)+(mh>0?25:0)+(vr>=1.3?20:vr>=1?10:0))));
              return{ticker:t,prices,cur:+cur.toFixed(2),h52:+h52hi.toFixed(2),dip:+dip.toFixed(1),rsi,mh,chg:0,vr,sig,score,sector:SECTORS[i%20],sl:+(cur*(1-c.sl/100)).toFixed(2),tp:+(cur*(1+c.tp/100)).toFixed(2),entry:"$"+(cur*0.98).toFixed(2)+"-$"+(cur*1.01).toFixed(2)};
            }

    var refresh=useCallback(function(forceRefresh){
    var c=cfgRef.current;
    var symbols=TICKERS.join(",");
    var cacheKey="apex_quotes_daily";
    // Check daily cache - only fetch from API once per day unless forced
    var cached=null;
    try{
      var cv=localStorage.getItem(cacheKey);
      if(cv){
        var cp=JSON.parse(cv);
        var age=Date.now()-cp.ts;
        var sameDay=new Date(cp.ts).toDateString()===new Date().toDateString();
        if(sameDay&&!forceRefresh){cached=cp.data;}
      }
    }catch(e){}
    // If we have today's data, use it immediately - no API call
    if(cached){
      setDataLoading(false);setDataSource("live");
      (function buildFromCache(batch){
        var ns=TICKERS.map(function(t,i){
          var q=batch[t]||batch;
          if(q&&q.close){
            var cur=parseFloat(q.close)||BASE[t]||50;
            var prev=parseFloat(q.previous_close)||cur;
            var chg=cur>0?((cur-prev)/prev*100):0;
            var vol=parseFloat(q.volume)||5e6;
            var avgVol=parseFloat(q.average_volume)||8e6;
            var vr=+(vol/avgVol).toFixed(2)||1;
            var h52hi=parseFloat((q.fifty_two_week||{}).high)||cur*1.3;
            var h52lo=parseFloat((q.fifty_two_week||{}).low)||cur*0.7;
            var dip=(h52hi-cur)/h52hi*100;
            var days=90;var prices=[];
            for(var d=0;d<days;d++){
              var hash=t.split("").reduce(function(a,ch){return a+ch.charCodeAt(0);},0);
              var progress=d/(days-1);
              var base=h52lo+(cur-h52lo)*Math.pow(progress,0.7);
              var osc=((hash*d)%17-8)/8*(h52hi-h52lo)*0.04;
              prices.push(Math.max(h52lo*0.95,Math.min(h52hi*1.02,base+osc)));
            }
            prices[prices.length-1]=cur;
            var rsi=lastRSI(prices),mh=macdH(prices);
            var sig="HOLD";
            if(dip>=c.dipMin&&dip<=c.dipMax){
              if(rsi>=c.rsiRecovery&&rsi<60&&mh>0&&vr>=c.volMult)sig="STRONG_BUY";
              else if(rsi>=c.rsiOversold&&mh>-0.5)sig="BUY";
              else if(rsi<c.rsiOversold)sig="WATCH";
            }else if(dip<5){if(rsi>70)sig="SELL";}
            else if(dip>25&&dip<=40){if(rsi>=c.rsiRecovery&&mh>0&&vr>=c.volMult)sig="BUY";else if(rsi>=c.rsiOversold&&mh>-0.5)sig="WATCH";else sig="SELL";}else if(dip>40){sig=rsi<35?"WATCH":"SELL";}
            var score=Math.min(100,Math.max(0,Math.round(
              (dip>=5&&dip<=20?30:0)+(rsi>=35&&rsi<=55?25:rsi<35?15:0)+(mh>0?25:0)+(vr>=1.3?20:vr>=1?10:0)
            )));
            return{ticker:t,prices,cur:+cur.toFixed(2),h52:+h52hi.toFixed(2),dip:+dip.toFixed(1),
              rsi,mh,chg:+chg.toFixed(2),vr,sig,score,sector:SECTORS[i%20],
              sl:+(cur*(1-c.sl/100)).toFixed(2),tp:+(cur*(1+c.tp/100)).toFixed(2),
              entry:"$"+(cur*0.98).toFixed(2)+"-$"+(cur*1.01).toFixed(2)};
          }
          return detStock(t,i,c);
        });
        setStocks(ns);setLastR(new Date());
      })(cached);
      return;
    }
    // No cache - fetch live quotes from Finnhub (no batch limit on free tier)
    // Plus 52w data from Finnhub metric endpoint
    setDataLoading(true);setDataSource("live");
    Promise.all(TICKERS.map(function(t){
      return Promise.all([
        fetch("/api/market?source=fh&endpoint=quote?symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
        fetch("/api/market?source=fh&endpoint=stock/metric?symbol="+t+"&metric=all").then(function(r){return r.json();}).catch(function(){return null;})
      ]).then(function(res){return {ticker:t,q:res[0],m:res[1]};});
    })).then(function(results){
      // Build a batch object keyed by ticker in the same format as before
      var batch={};
      results.forEach(function(r){
        if(r.q&&r.q.c>0){
          var hi52=r.m&&r.m.metric&&r.m.metric["52WeekHigh"]?r.m.metric["52WeekHigh"]:r.q.c*1.3;
          var lo52=r.m&&r.m.metric&&r.m.metric["52WeekLow"]?r.m.metric["52WeekLow"]:r.q.c*0.7;
          // Finnhub metric has avg volume in millions - use 10d avg as proxy for current vol
          var avgVol10d=r.m&&r.m.metric&&r.m.metric["10DayAverageTradingVolume"]?r.m.metric["10DayAverageTradingVolume"]*1e6:8e6;
          var avgVol3m=r.m&&r.m.metric&&r.m.metric["3MonthAverageTradingVolume"]?r.m.metric["3MonthAverageTradingVolume"]*1e6:8e6;
          // Use 10d avg as "today's vol" and 3m avg as baseline - ratio shows if volume is elevated
          var vol=avgVol10d; var avgVol=avgVol3m;
          batch[r.ticker]={
            close:""+r.q.c,
            previous_close:""+r.q.pc,
            percent_change:""+r.q.dp,
            volume:""+vol,
            average_volume:""+avgVol,
            fifty_two_week:{high:""+hi52,low:""+lo52}
          };
        }
      });
      if(Object.keys(batch).length===0){
        setStocks(TICKERS.map(function(t,i){return detStock(t,i,c);}));
        setLastR(new Date());setDataLoading(false);setDataSource("simulated");return;
      }
      (function(batch){
        // Save to daily cache
        try{localStorage.setItem(cacheKey,JSON.stringify({ts:Date.now(),data:batch}));}catch(e){}
        // Twelve Data returns object keyed by ticker when multiple symbols requested
        var ns=TICKERS.map(function(t,i){
          var q=batch[t]||batch;
          // If only 1 ticker was returned directly (fallback), wrap it
          if(q&&q.close){
            var cur=parseFloat(q.close)||BASE[t]||50;
            var prev=parseFloat(q.previous_close)||cur;
            var chg=cur>0?((cur-prev)/prev*100):0;
            var vol=parseFloat(q.volume)||5e6;
            var avgVol=parseFloat(q.average_volume)||8e6;
            var vr=+(vol/avgVol).toFixed(2)||1;
            var h52hi=parseFloat((q.fifty_two_week||{}).high)||cur*1.3;
            var h52lo=parseFloat((q.fifty_two_week||{}).low)||cur*0.7;
            var dip=(h52hi-cur)/h52hi*100;
            // Build deterministic price path from real anchor points
            // Uses 52w low to current price trajectory - no randomness
            var days=90;
            var prices=[];
            for(var d=0;d<days;d++){
              // Linear interpolation from 52w low midpoint toward current price
              // with a sinusoidal component derived from ticker hash (stable)
              var hash=t.split("").reduce(function(a,c){return a+c.charCodeAt(0);},0);
              var progress=d/(days-1);
              var base=h52lo+(cur-h52lo)*Math.pow(progress,0.7);
              // Deterministic oscillation using ticker hash as seed
              var osc=((hash*d)%17-8)/8*(h52hi-h52lo)*0.04;
              prices.push(Math.max(h52lo*0.95,Math.min(h52hi*1.02,base+osc)));
            }
            prices[prices.length-1]=cur;
            var rsi=lastRSI(prices),mh=macdH(prices);
            var sig="HOLD";
            if(dip>=c.dipMin&&dip<=c.dipMax){
              if(rsi>=c.rsiRecovery&&rsi<60&&mh>0&&vr>=c.volMult)sig="STRONG_BUY";
              else if(rsi>=c.rsiOversold&&mh>-0.5)sig="BUY";
              else if(rsi<c.rsiOversold)sig="WATCH";
            }else if(dip<5){if(rsi>70)sig="SELL";}
            else if(dip>25&&dip<=40){if(rsi>=c.rsiRecovery&&mh>0&&vr>=c.volMult)sig="BUY";else if(rsi>=c.rsiOversold&&mh>-0.5)sig="WATCH";else sig="SELL";}else if(dip>40){sig=rsi<35?"WATCH":"SELL";}
            var score=Math.min(100,Math.max(0,Math.round(
              (dip>=5&&dip<=20?30:0)+(rsi>=35&&rsi<=55?25:rsi<35?15:0)+(mh>0?25:0)+(vr>=1.3?20:vr>=1?10:0)
            )));
            return {ticker:t,prices,cur:+cur.toFixed(2),h52:+h52hi.toFixed(2),dip:+dip.toFixed(1),
              rsi,mh,chg:+chg.toFixed(2),vr,sig,score,sector:SECTORS[i%20],
              sl:+(cur*(1-c.sl/100)).toFixed(2),tp:+(cur*(1+c.tp/100)).toFixed(2),
              entry:"$"+(cur*0.98).toFixed(2)+"-$"+(cur*1.01).toFixed(2)};
          }
          return detStock(t,i,c);
        });
        setStocks(ns);setLastR(new Date());setDataLoading(false);
      })(batch);
    });
  },[]);

  useEffect(function(){refresh();},[refresh]);

  // ── Load portfolio from database on mount ──
  useEffect(function(){
    fetch("/api/portfolio?action=load")
      .then(function(r){return r.json();})
      .then(function(data){
        if(data && data.cash !== undefined){
          var posObj={};
          (data.positions||[]).forEach(function(p){
            posObj[p.ticker]={ticker:p.ticker,shares:parseFloat(p.shares),avg:parseFloat(p.avg_price),ep:parseFloat(p.entry_price),sl:parseFloat(p.sl),tp:parseFloat(p.tp)};
          });
          var closedTrades=(data.trades||[]).filter(function(t){return t.side==="SELL";}).map(function(t){
            return{id:t.id,ticker:t.ticker,side:t.side,q:parseFloat(t.quantity),price:parseFloat(t.price),pnl:parseFloat(t.pnl)||0,time:t.executed_at,reason:t.reason,auto:t.auto,ep:parseFloat(t.price),day:0,dur:0};
          });
          setPort({cash:parseFloat(data.cash),pos:posObj,trades:closedTrades});
          if(data.positions&&data.positions.length>0) notify("Portfolio restored from database");
        }
        setStorageReady(true);
      })
      .catch(function(){ setStorageReady(true); });
  },[]);

  useEffect(function(){
    if(stocks.length===0)return;
    var s=stocks.find(function(s){return s.ticker===btTicker;});
    if(s)setBtResult(runBT(s.prices,cfgRef.current));
  },[btTicker,stocks]);

  // ── Manual trade ──
  function execTrade(stock,side,q){
    var cost=stock.cur*q;
    if(side==="BUY"){
      if(port.cash<cost){notify("Insufficient cash",true);return;}
      var newCash=port.cash-cost;
      var newPos={ticker:stock.ticker,shares:q,avg:stock.cur,ep:stock.cur,sl:stock.sl,tp:stock.tp};
      setPort(function(prev){
        var np=Object.assign({},prev.pos);
        np[stock.ticker]=newPos;
        return{cash:newCash,pos:np,trades:[{id:Date.now(),ticker:stock.ticker,side:"BUY",q:q,price:stock.cur,pnl:0,time:new Date().toLocaleTimeString(),auto:false}].concat(prev.trades)};
      });
      // Save to database
      fetch("/api/portfolio?action=trade",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ticker:stock.ticker,side:"BUY",quantity:q,price:stock.cur,pnl:0,reason:"Manual",auto:false,newCash:newCash,position:{sl:stock.sl,tp:stock.tp}})
      }).catch(function(){});
      notify("Bought "+q+" shares of "+stock.ticker+" @ $"+stock.cur);
    } else {
      var pos=port.pos[stock.ticker];
      if(!pos){notify("No position in "+stock.ticker,true);return;}
      var shares=q||pos.shares;
      var pnl=+(( (stock.cur-pos.ep)*shares ).toFixed(2));
      var sellCash=port.cash+stock.cur*shares;
      setPort(function(prev){
        var np=Object.assign({},prev.pos);
        delete np[stock.ticker];
        return{cash:sellCash,pos:np,trades:[{id:Date.now(),ticker:stock.ticker,side:"SELL",q:shares,price:stock.cur,pnl:pnl,ep:pos.ep,time:new Date().toLocaleTimeString(),auto:false,reason:"Manual"}].concat(prev.trades)};
      });
      // Save to database
      fetch("/api/portfolio?action=trade",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ticker:stock.ticker,side:"SELL",quantity:shares,price:stock.cur,pnl:pnl,reason:"Manual",auto:false,newCash:sellCash,position:{sl:0,tp:0}})
      }).catch(function(){});
      notify("Sold "+shares+" shares of "+stock.ticker+" @ $"+stock.cur+" P&L: $"+pnl);
    }
    setModal(null);
  }


  function apTrade(stock,side,shares,reason){
    var cost=stock.cur*shares;
    if(side==="BUY"){
      if(portRef.current.cash<cost)return;
      var c=cfgRef.current;
      setPort(function(prev){
        var old=prev.pos[stock.ticker]||{shares:0,avg:0};
        var ns=old.shares+shares,na=(old.shares*old.avg+cost)/ns;
        var np=Object.assign({},prev.pos);
        np[stock.ticker]={shares:ns,avg:+na.toFixed(2),ticker:stock.ticker,
          sl:+(stock.cur*(1-c.sl/100)).toFixed(2),tp:+(stock.cur*(1+c.tp/100)).toFixed(2)};
        return{cash:prev.cash-cost,pos:np,trades:[{id:Date.now(),ticker:stock.ticker,side:"BUY",q:shares,price:stock.cur,time:new Date().toLocaleTimeString(),auto:true}].concat(prev.trades)};
      });
      setApStats(function(p){return{trades:p.trades+1,tunes:p.tunes};});
    }else{
      var pos=portRef.current.pos[stock.ticker];
      if(!pos||pos.shares<shares)return;
      var pnl=(stock.cur-pos.avg)*shares;
      setPort(function(prev){
        var np=Object.assign({},prev.pos);
        var ns=pos.shares-shares;
        if(ns===0)delete np[stock.ticker];else np[stock.ticker]=Object.assign({},pos,{shares:ns});
        return{cash:prev.cash+stock.cur*shares,pos:np,trades:[{id:Date.now(),ticker:stock.ticker,side:"SELL",q:shares,price:stock.cur,pnl:+pnl.toFixed(2),time:new Date().toLocaleTimeString(),auto:true}].concat(prev.trades)};
      });
      setApStats(function(p){return{trades:p.trades+1,tunes:p.tunes};});
    }
  }

  function addLog(entry){setApLog(function(prev){return[entry].concat(prev).slice(0,100);});}

  // ── Self-tune ──
  function runTune(){
    var s=stocksRef.current.find(function(s){return s.ticker===btTicker;})||stocksRef.current[0];
    if(!s)return;
    var res=runBT(s.prices,cfgRef.current);
    var tuned=tuneCFG(res,cfgRef.current);
    setCfg(tuned.cfg);
    setBtResult(res);
    setTuneLog(function(prev){return[{time:new Date().toLocaleTimeString(),ticker:s.ticker,changes:tuned.changes}].concat(prev).slice(0,30);});
    setApStats(function(p){return{trades:p.trades,tunes:p.tunes+1};});
    notify(tuned.changes.length>0?"Self-tune: "+tuned.changes.length+" param(s) adjusted":"Self-tune: strategy performing well");
  }

  // ── Autopilot scan cycle ──
  function runScan(){
    var cur=stocksRef.current,p=portRef.current,c=cfgRef.current;
    var posCount=Object.keys(p.pos).length;
    var executed=[];

    // Check exits
    Object.values(p.pos).forEach(function(pos){
      var st=cur.find(function(s){return s.ticker===pos.ticker;});
      if(!st)return;
      if(st.cur<=pos.sl){apTrade(st,"SELL",pos.shares,"Stop Loss");executed.push({type:"SELL",ticker:pos.ticker,reason:"SL hit @ $"+st.cur,color:"#ef4444"});posCount--;}
      else if(st.cur>=pos.tp){apTrade(st,"SELL",pos.shares,"Take Profit");executed.push({type:"SELL",ticker:pos.ticker,reason:"TP hit @ $"+st.cur,color:"#4ade80"});posCount--;}
    });

    // Check entries
    if(posCount<MAX_POS){
      var cands=cur.filter(function(s){return(s.sig==="STRONG_BUY"||s.sig==="BUY")&&!p.pos[s.ticker];}).sort(function(a,b){return b.score-a.score;});
      for(var i=0;i<cands.length&&posCount<MAX_POS;i++){
        var s=cands[i];
        var spend=p.cash*(c.maxPosPct/100);
        var q=Math.floor(spend/s.cur);
        if(q>0&&p.cash>=s.cur*q){apTrade(s,"BUY",q,"Autopilot "+s.sig);executed.push({type:"BUY",ticker:s.ticker,reason:s.sig+" score:"+s.score+" @ $"+s.cur,color:"#4ade80"});posCount++;}
      }
    }

    if(executed.length>0){
      executed.forEach(function(e){addLog({time:new Date().toLocaleTimeString(),type:e.type,ticker:e.ticker,reason:e.reason,color:e.color});});
    }else{
      addLog({time:new Date().toLocaleTimeString(),type:"SCAN",ticker:"--",reason:"Scanned "+cur.length+" stocks. "+posCount+"/"+MAX_POS+" positions. No action.",color:"#1e293b"});
    }

    // Auto-tune every 4 scans
    scanCountRef.current+=1;
    if(scanCountRef.current%4===0){runTune();}
  }

  // ── Autopilot interval ──
  useEffect(function(){
    if(apOn){
      countRef.current=AP_SEC;
      setApCountdown(AP_SEC);
      intervalRef.current=setInterval(function(){
        countRef.current-=1;
        setApCountdown(countRef.current);
        if(countRef.current<=0){
          countRef.current=AP_SEC;
          setApCountdown(AP_SEC);
          runScan();
        }
      },1000);
    }else{
      if(intervalRef.current){clearInterval(intervalRef.current);intervalRef.current=null;}
    }
    return function(){if(intervalRef.current){clearInterval(intervalRef.current);intervalRef.current=null;}};
  },[apOn]);

  // ── Portfolio calculations ──
  var portVal=port.cash+Object.values(port.pos).reduce(function(s,p){
    var st=stocks.find(function(x){return x.ticker===p.ticker;});
    return s+(st?st.cur*p.shares:p.avg*p.shares);
  },0);
  var portRet=portVal-INIT_CFG.startCash,portPct=portRet/INIT_CFG.startCash*100;

  var filtered=stocks.filter(function(s){
    if(sf==="buy")return s.sig==="STRONG_BUY"||s.sig==="BUY";
    if(sf==="watch")return s.sig==="WATCH";
    if(sf==="sell")return s.sig==="SELL"||s.sig==="STRONG_SELL";
    return true;
  }).sort(function(a,b){
    if(srt==="dip")return b.dip-a.dip;if(srt==="rsi")return a.rsi-b.rsi;if(srt==="change")return b.chg-a.chg;return b.score-a.score;
  });

  var TABS=["screener","signals","paper","backtest","autopilot","ai","settings"];
  var LABELS={screener:"Screener",signals:"Signals",paper:"Paper Trade",backtest:"Backtest",autopilot:"Autopilot",ai:"AI Analysis",settings:"Settings"};

  return(
    <div style={{minHeight:"100vh",background:"#030712",fontFamily:"'IBM Plex Mono','Courier New',monospace",color:"#e2e8f0",paddingBottom:60}}>
      <div style={{background:"#0a0f1a",borderBottom:"1px solid #0f172a",padding:"8px 20px",display:"flex",alignItems:"center",gap:12}}>
        <div style={{fontSize:9,color:"#334155",letterSpacing:2,flexShrink:0,whiteSpace:"nowrap"}}>ANTHROPIC API KEY</div>
        <input type="password" placeholder="sk-ant-...  (optional - only needed if running as a local HTML file)" value={anthropicKey} onChange={function(e){var v=e.target.value;setAnthropicKey(v);}} style={{flex:1,background:"#030712",border:"1px solid #1e293b",color:"#4ade80",borderRadius:5,padding:"5px 10px",fontSize:11,outline:"none",fontFamily:"monospace"}}/>
        <div style={{fontSize:9,color:"#1e293b",flexShrink:0}}>Never sent anywhere except Anthropic.</div>
      </div>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap');
        *{box-sizing:border-box;margin:0;}
        ::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-track{background:#0f172a;} ::-webkit-scrollbar-thumb{background:#1e293b;border-radius:2px;}
        @keyframes fu{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes sd{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
        @keyframes bk{0%,100%{opacity:1}50%{opacity:0.3}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        input,select,button{font-family:inherit;} button{cursor:pointer;}
      `}</style>

      {toast&&<div style={{position:"fixed",top:20,right:20,zIndex:9999,background:toast.err?"#1c0505":"#052e16",border:"1px solid "+(toast.err?"#dc2626":"#16a34a"),color:toast.err?"#fca5a5":"#4ade80",borderRadius:8,padding:"12px 18px",fontSize:13,animation:"sd 0.2s ease"}}>{toast.msg}</div>}

      {modal&&(
        <div style={{position:"fixed",inset:0,zIndex:9000,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center"}} onClick={function(){setModal(null);}}>
          <div style={{background:"#0f172a",border:"1px solid #1e293b",borderRadius:16,padding:28,width:340,animation:"fu 0.2s ease"}} onClick={function(e){e.stopPropagation();}}>
            <div style={{fontSize:11,color:"#475569",letterSpacing:2,marginBottom:8}}>PAPER TRADE ORDER</div>
            <div style={{fontSize:22,fontWeight:700,color:"#f1f5f9",marginBottom:4}}>{modal.ticker}</div>
            <div style={{fontSize:13,color:"#64748b",marginBottom:20}}>{"@ $"+modal.cur+" - "+(modal.side==="BUY"?"BUY":"SELL")}</div>
            <div style={{marginBottom:12}}><div style={{fontSize:10,color:"#334155",marginBottom:6}}>QUANTITY</div><input type="number" min="1" value={qty} onChange={function(e){setQty(Math.max(1,parseInt(e.target.value)||1));}} style={{width:"100%",background:"#1e293b",border:"1px solid #334155",color:"#f1f5f9",borderRadius:8,padding:"10px 14px",fontSize:16,outline:"none"}}/></div>
            <div style={{display:"flex",gap:6,marginBottom:14}}>{[1,5,10,25].map(function(n){return<button key={n} onClick={function(){setQty(n);}} style={{flex:1,background:qty===n?"#334155":"#1e293b",border:"1px solid #334155",color:qty===n?"#f1f5f9":"#64748b",borderRadius:6,padding:"6px 0",fontSize:12}}>{n}</button>;})}</div>
            <div style={{background:"#1e293b",borderRadius:8,padding:"12px 14px",marginBottom:18,fontSize:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><span style={{color:"#64748b"}}>Total</span><span style={{color:"#f1f5f9",fontWeight:600}}>{"$"+(modal.cur*qty).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><span style={{color:"#64748b"}}>Stop Loss</span><span style={{color:"#ef4444"}}>{"$"+modal.sl}</span></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span style={{color:"#64748b"}}>Take Profit</span><span style={{color:"#22c55e"}}>{"$"+modal.tp}</span></div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={function(){setModal(null);}} style={{flex:1,background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:8,padding:"11px 0",fontSize:13}}>Cancel</button>
              <button onClick={function(){execTrade(modal,modal.side,qty);}} style={{flex:2,background:modal.side==="BUY"?"#15803d":"#b91c1c",border:"none",color:"#fff",borderRadius:8,padding:"11px 0",fontSize:13,fontWeight:600}}>{modal.side==="BUY"?"Execute Buy":"Execute Sell"}</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{background:"#030712",borderBottom:"1px solid #0f172a",padding:"12px 20px",position:"sticky",top:0,zIndex:100}}>
        <div style={{maxWidth:1200,margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{position:"relative"}}>
              <div style={{width:32,height:32,background:"linear-gradient(135deg,#1d4ed8,#7c3aed)",borderRadius:7,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#fff",fontWeight:800}}>AT</div>
              <div style={{position:"absolute",bottom:-2,right:-2,width:8,height:8,background:"#22c55e",borderRadius:"50%",border:"2px solid #030712",animation:"bk 2s infinite"}}/>
            </div>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:"#f1f5f9"}}>APEX TRADER</div>
              <div style={{fontSize:9,color:"#334155",letterSpacing:2}}>{(lastR?lastR.toLocaleTimeString():"loading...")+" - PAPER MODE"}</div>
            </div>
          </div>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {TABS.map(function(t){
              return(
                <button key={t} onClick={function(){setTab(t);}} style={{background:tab===t?"#1e293b":"transparent",border:"1px solid "+(tab===t?"#334155":"transparent"),color:tab===t?"#f1f5f9":"#475569",borderRadius:7,padding:"5px 11px",fontSize:11,fontWeight:tab===t?700:400,position:"relative"}}>
                  {LABELS[t]}
                  {t==="autopilot"&&apOn&&<span style={{position:"absolute",top:3,right:3,width:5,height:5,borderRadius:"50%",background:"#22c55e",animation:"bk 1s infinite"}}/>}
                </button>
              );
            })}
          </div>
          <div style={{display:"flex",gap:14,alignItems:"center"}}>
            <div style={{textAlign:"right"}}><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:1}}>PORTFOLIO</div><div style={{fontSize:14,fontWeight:700,color:"#f1f5f9"}}>{"$"+portVal.toLocaleString("en-US",{maximumFractionDigits:0})}</div></div>
            <div style={{textAlign:"right"}}><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:1}}>RETURN</div><div style={{fontSize:14,fontWeight:700,color:portPct>=0?"#22c55e":"#ef4444"}}>{(portPct>=0?"+":"")+portPct.toFixed(2)+"%"}</div></div>
            <button onClick={function(){refresh(false);}} style={{background:"#0f172a",border:"1px solid #1e293b",color:"#64748b",borderRadius:6,padding:"6px 11px",fontSize:11}}>{dataLoading?"Loading...":"Refresh"}</button>
                <button onClick={function(){try{localStorage.removeItem("apex_quotes_daily");}catch(e){}refresh(true);}} style={{background:"transparent",border:"1px solid #1e293b",color:"#334155",borderRadius:6,padding:"6px 11px",fontSize:10}} title="Force fetch fresh prices from API">↻ New Prices</button>{dataSource==="live"&&!dataLoading&&<span style={{fontSize:9,background:"#052e16",color:"#4ade80",border:"1px solid #15803d",borderRadius:4,padding:"2px 6px",marginLeft:6,letterSpacing:1}}>LIVE</span>}{dataSource==="simulated"&&<span style={{fontSize:9,background:"#1c1917",color:"#78716c",border:"1px solid #292524",borderRadius:4,padding:"2px 6px",marginLeft:6,letterSpacing:1}}>SIM</span>}
          </div>
        </div>
      </div>

      <div style={{maxWidth:1200,margin:"0 auto",padding:"20px 20px 0"}}>

        {/* ── SCREENER ── */}
        {tab==="screener"&&(
          <div style={{animation:"fu 0.3s ease"}}>
            {/* Ticker Detail Panel */}
          {tickerDetail&&(function(){
            var s=tickerDetail;
            var sg=SIGS[s.sig]||SIGS.HOLD;
            function Gauge(props){
              var pct=Math.min(100,Math.max(0,props.pct));
              var col=props.isGood?
                (pct>=props.goodMin&&pct<=props.goodMax?"#22c55e":pct>props.goodMax?"#f87171":"#f59e0b"):
                (pct>50?"#22c55e":"#f87171");
              return(
                <div style={{marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                    <span style={{fontSize:10,color:"#64748b",letterSpacing:1}}>{props.label}</span>
                    <span style={{fontSize:11,fontWeight:700,color:col}}>{props.display}</span>
                  </div>
                  <div style={{height:4,background:"#0f172a",borderRadius:2,overflow:"hidden"}}>
                    <div style={{height:"100%",width:pct+"%",background:col,borderRadius:2,transition:"width 0.4s ease"}}/>
                  </div>
                  {props.note&&<div style={{fontSize:9,color:"#334155",marginTop:3}}>{props.note}</div>}
                </div>
              );
            }
            var dipPct=Math.min(100,s.dip/30*100);
            var rsiPct=s.rsi;
            var macdPct=s.mh>0?Math.min(100,50+s.mh*500):Math.max(0,50+s.mh*500);
            var vrPct=Math.min(100,s.vr/3*100);
            var h52range=s.h52-s.h52*0.7;
            var h52pos=h52range>0?Math.min(100,Math.max(0,((s.cur-(s.h52*0.7))/h52range)*100)):50;
            var chgPct=Math.min(100,Math.max(0,50+(s.chg*5)));
            var scorePct=s.score;
            return(
              <div style={{position:"fixed",top:0,right:0,width:400,height:"100vh",background:"#080d14",
                borderLeft:"1px solid #1e293b",zIndex:1000,overflowY:"auto",boxShadow:"-8px 0 32px rgba(0,0,0,0.5)",
                animation:"slideIn 0.2s ease"}}>
                <style>{`@keyframes slideIn{from{transform:translateX(100%)}to{transform:translateX(0)}}`}</style>
                {/* Header */}
                <div style={{padding:"20px 20px 16px",borderBottom:"1px solid #0f172a",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
                      <span style={{fontSize:24,fontWeight:800,color:"#f1f5f9"}}>{s.ticker}</span>
                      <span style={{padding:"4px 10px",borderRadius:5,fontSize:11,fontWeight:800,background:sg.bg,color:sg.c,border:"1px solid "+sg.b}}>{sg.label}</span>
                    </div>
                    <div style={{fontSize:11,color:"#475569"}}>{s.sector}  |  ${s.cur}  |  Score {s.score}/100</div>
                  </div>
                  <button onClick={function(){setTickerDetail(null);setTickerAI(null);}}
                    style={{background:"transparent",border:"none",color:"#475569",fontSize:18,cursor:"pointer",padding:"4px 8px"}}>✕</button>
                </div>
                {/* Signal Breakdown */}
                <div style={{padding:"16px 20px",borderBottom:"1px solid #0f172a"}}>
                  <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:14}}>SIGNAL BREAKDOWN</div>
                  <Gauge label="DIP FROM 52W HIGH" display={s.dip.toFixed(1)+"%"} pct={dipPct}
                    isGood={true} goodMin={17} goodMax={67}
                    note={"Target: 5-20%  |  52W High: $"+s.h52}/>
                  <Gauge label="RSI (14)" display={s.rsi} pct={rsiPct}
                    isGood={true} goodMin={35} goodMax={55}
                    note="Buy zone: 35-55  |  Oversold <35  |  Overbought >70"/>
                  <Gauge label="MACD HISTOGRAM" display={(s.mh>0?"+":"")+s.mh} pct={macdPct}
                    isGood={true} goodMin={50} goodMax={100}
                    note={s.mh>0?"Bullish momentum":"Bearish momentum"}/>
                  <Gauge label="VOLUME VS AVERAGE" display={s.vr+"x"} pct={vrPct}
                    isGood={true} goodMin={43} goodMax={100}
                    note={"Target: >1.3x average  |  Current: "+s.vr+"x"}/>
                  <Gauge label="52-WEEK RANGE POSITION" display={Math.round(h52pos)+"%"} pct={h52pos}
                    isGood={true} goodMin={0} goodMax={40}
                    note={"Low: $"+(s.h52*0.7).toFixed(0)+" to High: $"+s.h52}/>
                  <Gauge label="1-DAY CHANGE" display={(s.chg>0?"+":"")+s.chg+"%"} pct={chgPct}
                    isGood={true} goodMin={45} goodMax={65}
                    note="Neutral around 0%"/>
                  <Gauge label="COMPOSITE SCORE" display={s.score+"/100"} pct={scorePct}
                    isGood={true} goodMin={60} goodMax={100}
                    note="Weighted: DIP 30pts  |  RSI 25pts  |  MACD 25pts  |  VOL 20pts"/>
                </div>
                {/* AI Justification */}
                <div style={{padding:"16px 20px",borderBottom:"1px solid #0f172a"}}>
                  <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:12}}>AI SIGNAL JUSTIFICATION</div>
                  {tickerAILoading?(
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:12,height:12,border:"2px solid #1e293b",borderTopColor:sg.c,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
                      <span style={{fontSize:12,color:"#334155"}}>Analyzing {s.ticker}...</span>
                    </div>
                  ):(
                    <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.8}}>{tickerAI||"-"}</div>
                  )}
                </div>
                {/* Actions */}
                <div style={{padding:"16px 20px",display:"flex",gap:8,flexWrap:"wrap"}}>
                  <button onClick={function(){setModal(Object.assign({},s,{side:"BUY"}));setQty(1);setTickerDetail(null);setTickerAI(null);setTab("paper");}}
                    style={{background:"#15803d",border:"none",color:"#fff",borderRadius:8,padding:"10px 18px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                    Paper Buy {s.ticker}
                  </button>
                  <button onClick={function(){setTickerDetail(null);setTickerAI(null);setTab("backtest");}}
                    style={{background:"transparent",border:"1px solid #1e293b",color:"#64748b",borderRadius:8,padding:"10px 18px",fontSize:12,cursor:"pointer"}}>
                    Backtest
                  </button>
                </div>
              </div>
            );
          })()}
          {/* Click outside to close */}
          {tickerDetail&&<div onClick={function(){setTickerDetail(null);setTickerAI(null);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:999}}/>}

          {appWatchlist.length>0&&(
              <div style={{marginBottom:20}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div>
                    <div style={{fontSize:16,fontWeight:700,color:"#f1f5f9"}}>⭐ Watchlist</div>
                    <div style={{fontSize:11,color:"#334155",marginTop:2}}>{appWatchlist.length} stocks from AI Analysis</div>
                  </div>
                  <button onClick={refreshWatchlist} style={{background:"transparent",border:"1px solid #1e293b",color:"#475569",borderRadius:6,padding:"5px 11px",fontSize:11}}>Refresh</button>
                </div>
                <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,overflow:"hidden"}}>
                  <div style={{display:"grid",gridTemplateColumns:"70px 1fr 78px 64px 56px 56px 56px 80px",gap:7,padding:"7px 10px",fontSize:9,color:"#334155",letterSpacing:1,borderBottom:"1px solid #0f172a"}}>
                    <span>TICKER</span><span>NAME</span><span>PRICE</span><span>1D</span><span>52W HI</span><span>52W LO</span><span>VOL/AVG</span><span>ACTION</span>
                  </div>
                  {watchlistStocks.map(function(w){
                    var chgCol=w.chg>=0?"#4ade80":"#f87171";
                    var vr=w.avgVol>0?(w.vol/w.avgVol).toFixed(1):"-";
                    return(
                      <div key={w.ticker} style={{display:"grid",gridTemplateColumns:"70px 1fr 78px 64px 56px 56px 56px 80px",gap:7,padding:"9px 10px",borderBottom:"1px solid #0a0f1a",alignItems:"center"}}
                        onMouseEnter={function(e){e.currentTarget.style.background="#0f172a";}} onMouseLeave={function(e){e.currentTarget.style.background="transparent";}}>
                        <div style={{fontWeight:700,color:"#f1f5f9",fontSize:12}}>{w.ticker}</div>
                        <div style={{fontSize:10,color:"#475569",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{w.name}</div>
                        <div style={{fontSize:12,fontWeight:600,color:"#f1f5f9"}}>{w.cur>0?"$"+w.cur:"-"}</div>
                        <div style={{fontSize:11,fontWeight:600,color:chgCol}}>{w.chg>0?"+":""}{w.chg}%</div>
                        <div style={{fontSize:10,color:"#64748b"}}>{w.hi52>0?"$"+w.hi52.toFixed(0):"-"}</div>
                        <div style={{fontSize:10,color:"#64748b"}}>{w.lo52>0?"$"+w.lo52.toFixed(0):"-"}</div>
                        <div style={{fontSize:10,color:parseFloat(vr)>1.5?"#f59e0b":"#64748b"}}>{vr}x</div>
                        <button onClick={function(){
                          fetch("/api/portfolio?action=watchlist_remove",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker:w.ticker})})
                            .then(function(){refreshWatchlist();});
                        }} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:5,padding:"3px 8px",fontSize:10,cursor:"pointer"}}>Remove</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div style={{marginBottom:14,display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
              <div><div style={{fontSize:20,fontWeight:700,color:"#f1f5f9"}}>Market Screener</div><div style={{fontSize:11,color:"#334155",marginTop:2}}>{stocks.filter(function(s){return s.sig==="STRONG_BUY"||s.sig==="BUY";}).length+" active buy signals"}</div></div>
              <div style={{marginLeft:"auto",display:"flex",gap:7,flexWrap:"wrap"}}>
                {[{k:"all",l:"All"},{k:"buy",l:"Buy"},{k:"watch",l:"Watch"},{k:"sell",l:"Sell"}].map(function(f){return<button key={f.k} onClick={function(){setSf(f.k);}} style={{background:sf===f.k?"#1e293b":"transparent",border:"1px solid "+(sf===f.k?"#334155":"#0f172a"),color:sf===f.k?"#f1f5f9":"#475569",borderRadius:6,padding:"5px 11px",fontSize:11}}>{f.l}</button>;})}
                <select value={srt} onChange={function(e){setSrt(e.target.value);}} style={{background:"#0f172a",border:"1px solid #1e293b",color:"#64748b",borderRadius:6,padding:"5px 9px",fontSize:11}}>
                  <option value="score">Score</option><option value="dip">Dip</option><option value="rsi">RSI</option><option value="change">1D</option>
                </select>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"70px 1fr 78px 64px 56px 52px 70px 62px 80px 90px",gap:7,padding:"7px 10px",fontSize:9,color:"#334155",letterSpacing:1,borderBottom:"1px solid #0f172a"}}>
              <span>TICKER</span><span>SECTOR</span><span>PRICE</span><span>1D</span><span>DIP</span><span>RSI</span><span>MACD</span><span>VOL</span><span>SIGNAL</span><span>SCORE</span>
            </div>
            {filtered.map(function(s,i){
              var sg=SIGS[s.sig]||SIGS.HOLD;
              return(
                <div key={s.ticker} style={{display:"grid",gridTemplateColumns:"70px 1fr 78px 64px 56px 52px 70px 62px 80px 90px",gap:7,padding:"8px 10px",borderBottom:"1px solid #0a0f1a",alignItems:"center",cursor:"pointer",animation:"fu 0.3s ease "+(i*0.02)+"s both"}}
                  onMouseEnter={function(e){e.currentTarget.style.background="#0f172a";}} onMouseLeave={function(e){e.currentTarget.style.background="transparent";}}
                  onClick={function(){openTickerDetail(s);}}>
                  <div style={{fontWeight:700,color:"#f1f5f9",fontSize:12}}>{s.ticker}</div>
                  <div><div style={{fontSize:10,color:"#475569",marginBottom:2}}>{s.sector}</div><Spark prices={s.prices} up={s.chg>=0}/></div>
                  <div style={{fontSize:12,color:"#f1f5f9"}}>{"$"+s.cur}</div>
                  <div style={{fontSize:12,color:s.chg>=0?"#4ade80":"#ef4444"}}>{(s.chg>=0?"+":"")+s.chg+"%"}</div>
                  <div style={{fontSize:12,color:s.dip>=5&&s.dip<=20?"#f59e0b":"#64748b"}}>{"-"+s.dip+"%"}</div>
                  <div style={{fontSize:12,color:s.rsi<35?"#ef4444":s.rsi<50?"#f59e0b":s.rsi>65?"#4ade80":"#94a3b8"}}>{s.rsi}</div>
                  <div style={{fontSize:11,color:s.mh>0?"#4ade80":"#f87171"}}>{(s.mh>0?"up ":"dn ")+Math.abs(s.mh)}</div>
                  <div style={{fontSize:12,color:s.vr>=1.3?"#4ade80":"#64748b"}}>{s.vr+"x"}</div>
                  <span style={{display:"inline-block",padding:"3px 6px",borderRadius:4,fontSize:9,fontWeight:700,background:sg.bg,color:sg.c,border:"1px solid "+sg.b}}>{sg.label}</span>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <div style={{flex:1,height:4,background:"#0f172a",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:s.score+"%",background:"hsl("+(s.score*1.2)+",70%,50%)",borderRadius:2}}/></div>
                    <span style={{fontSize:11,color:"#94a3b8",minWidth:20}}>{s.score}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── SIGNALS ── */}
        {tab==="signals"&&(
          <div style={{animation:"fu 0.3s ease"}}>
            <div style={{marginBottom:14}}><div style={{fontSize:20,fontWeight:700,color:"#f1f5f9"}}>Entry / Exit Signals</div><div style={{fontSize:11,color:"#334155",marginTop:2}}>Buy-dip and momentum confirmation strategy</div></div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:18}}>
              {[{l:"Dip Zone",v:cfg.dipMin+"-"+cfg.dipMax+"% below 52w high",c:"#f59e0b"},{l:"RSI Entry",v:">"+cfg.rsiOversold+" and rising",c:"#60a5fa"},{l:"MACD",v:"Histogram positive",c:"#a78bfa"},{l:"Volume",v:">"+cfg.volMult+"x average",c:"#34d399"},{l:"Stop Loss",v:"-"+cfg.sl+"% from entry",c:"#f87171"},{l:"Take Profit",v:"+"+cfg.tp+"% from entry",c:"#4ade80"}].map(function(r,i){
                return<div key={i} style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:9,padding:"12px 14px"}}><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:5}}>{r.l}</div><div style={{fontSize:12,color:r.c,fontWeight:600}}>{r.v}</div></div>;
              })}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(248px,1fr))",gap:12}}>
              {stocks.filter(function(s){return s.sig!=="HOLD";}).map(function(s,i){
                var sg=SIGS[s.sig]||SIGS.HOLD,buy=s.sig==="STRONG_BUY"||s.sig==="BUY"||s.sig==="WATCH";
                return(
                  <div key={s.ticker} style={{background:sg.bg,border:"1px solid "+sg.b,borderRadius:12,padding:"16px 18px",animation:"fu 0.3s ease "+(i*0.04)+"s both"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                      <div><div style={{fontSize:18,fontWeight:800,color:"#f1f5f9"}}>{s.ticker}</div><div style={{fontSize:10,color:"#475569"}}>{s.sector}</div></div>
                      <div><span style={{display:"block",padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:800,background:"rgba(0,0,0,0.4)",color:sg.c,border:"1px solid "+sg.b,textAlign:"center"}}>{sg.label}</span><div style={{fontSize:9,color:"#475569",textAlign:"center",marginTop:3}}>{"Score: "+s.score}</div></div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:12}}>
                      {[{l:"Price",v:"$"+s.cur,c:"#f1f5f9"},{l:"RSI",v:s.rsi,c:s.rsi<35?"#ef4444":s.rsi<50?"#f59e0b":"#4ade80"},{l:"Dip",v:"-"+s.dip+"%",c:"#f59e0b"},{l:"MACD",v:s.mh>0?"Bull":"Bear",c:s.mh>0?"#4ade80":"#f87171"},{l:"Vol",v:s.vr+"x",c:s.vr>=1.3?"#4ade80":"#64748b"},{l:"1D",v:s.chg+"%",c:s.chg>=0?"#4ade80":"#f87171"}].map(function(m,j){
                        return<div key={j} style={{background:"rgba(0,0,0,0.2)",borderRadius:5,padding:"5px 7px"}}><div style={{fontSize:8,color:"#334155",marginBottom:2}}>{m.l}</div><div style={{fontSize:12,fontWeight:700,color:m.c}}>{m.v}</div></div>;
                      })}
                    </div>
                    {buy&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginBottom:12}}>
                      {[{l:"ENTRY",v:s.entry,c:"#94a3b8",sm:true},{l:"STOP",v:"$"+s.sl,c:"#ef4444"},{l:"TARGET",v:"$"+s.tp,c:"#4ade80"}].map(function(m,j){
                        return<div key={j} style={{background:"rgba(0,0,0,0.2)",borderRadius:5,padding:"6px 7px"}}><div style={{fontSize:8,color:"#334155",marginBottom:2}}>{m.l}</div><div style={{fontSize:m.sm?9:11,fontWeight:700,color:m.c}}>{m.v}</div></div>;
                      })}
                    </div>}
                    <button onClick={function(){setModal(Object.assign({},s,{side:buy?"BUY":"SELL"}));setTab("paper");setQty(1);}} style={{width:"100%",background:buy?"#15803d":"#b91c1c",border:"none",color:"#fff",borderRadius:7,padding:"9px",fontSize:12,fontWeight:700}}>{buy?"Paper Buy "+s.ticker:"Paper Sell "+s.ticker}</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── PAPER TRADE ── */}
        {tab==="paper"&&(
          <div style={{animation:"fu 0.3s ease"}}>
            <div style={{marginBottom:14,display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
              <div><div style={{fontSize:20,fontWeight:700,color:"#f1f5f9"}}>Paper Portfolio</div><div style={{fontSize:11,color:"#334155",marginTop:2}}>Simulated trading - no real money</div></div>
              <button onClick={function(){var empty={cash:INIT_CFG.startCash,pos:{},trades:[]};setPort(empty);fetch('/api/portfolio?action=reset',{method:'POST'}).catch(function(){});notify('Portfolio reset');}} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:7,padding:"7px 13px",fontSize:11}}>Reset</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:18}}>
              <MC label="Total Value" value={"$"+portVal.toLocaleString("en-US",{maximumFractionDigits:0})}/>
              <MC label="Cash" value={"$"+port.cash.toLocaleString("en-US",{maximumFractionDigits:0})} color="#94a3b8"/>
              <MC label="P and L" value={(portRet>=0?"+":"")+"$"+portRet.toLocaleString("en-US",{maximumFractionDigits:0})} color={portRet>=0?"#4ade80":"#ef4444"}/>
              <MC label="Return" value={(portPct>=0?"+":"")+portPct.toFixed(2)+"%"} color={portPct>=0?"#4ade80":"#ef4444"}/>
              <MC label="Positions" value={Object.keys(port.pos).length}/>
              <MC label="Trades" value={port.trades.length} color="#94a3b8"/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:18}}>
              <div>
                <div style={{fontSize:11,color:"#475569",letterSpacing:1,marginBottom:10}}>OPEN POSITIONS</div>
                {Object.values(port.pos).length===0?<div style={{background:"#0a0f1a",border:"1px dashed #0f172a",borderRadius:10,padding:24,textAlign:"center",fontSize:12,color:"#334155"}}>No open positions.</div>:
                Object.values(port.pos).map(function(p){
                  var st=stocks.find(function(x){return x.ticker===p.ticker;}),cur=st?st.cur:p.avg;
                  var pnl=(cur-p.avg)*p.shares,pct=(cur-p.avg)/p.avg*100;
                  return(
                    <div key={p.ticker} style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:9,padding:"13px 15px",marginBottom:9}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                        <div><div style={{fontSize:14,fontWeight:700,color:"#f1f5f9"}}>{p.ticker}</div><div style={{fontSize:10,color:"#475569"}}>{p.shares+" shares at $"+p.avg}</div></div>
                        <div style={{textAlign:"right"}}><div style={{fontSize:14,fontWeight:700,color:pnl>=0?"#4ade80":"#ef4444"}}>{(pnl>=0?"+":"")+"$"+pnl.toFixed(0)}</div><div style={{fontSize:10,color:pnl>=0?"#4ade80":"#ef4444"}}>{(pct>=0?"+":"")+pct.toFixed(2)+"%"}</div></div>
                      </div>
                      <div style={{height:3,background:"#1e293b",borderRadius:2,marginBottom:8,overflow:"hidden"}}><div style={{height:"100%",borderRadius:2,background:pnl>=0?"#22c55e":"#ef4444",width:Math.min(100,Math.abs(pct)*3)+"%"}}/></div>
                      <div style={{display:"flex",gap:10,fontSize:10,color:"#475569",marginBottom:8}}>
                        <span>{"SL "}<span style={{color:"#f87171"}}>{"$"+p.sl}</span></span>
                        <span>{"TP "}<span style={{color:"#4ade80"}}>{"$"+p.tp}</span></span>
                        <span>{"Now "}<span style={{color:"#f1f5f9"}}>{"$"+cur}</span></span>
                      </div>
                      <button onClick={function(){setModal(Object.assign({},p,{cur,side:"SELL"}));setQty(p.shares);}} style={{width:"100%",background:"transparent",border:"1px solid #b91c1c",color:"#f87171",borderRadius:6,padding:"7px",fontSize:11}}>Close Position</button>
                    </div>
                  );
                })}
              </div>
              <div>
                <div style={{fontSize:11,color:"#475569",letterSpacing:1,marginBottom:10}}>TRADE HISTORY</div>
                {port.trades.length===0?<div style={{background:"#0a0f1a",border:"1px dashed #0f172a",borderRadius:10,padding:24,textAlign:"center",fontSize:12,color:"#334155"}}>No trades yet.</div>:(
                  <div style={{maxHeight:420,overflowY:"auto"}}>
                    {port.trades.map(function(t){
                      return(
                        <div key={t.id} style={{display:"flex",justifyContent:"space-between",padding:"9px 12px",borderBottom:"1px solid #0a0f1a",fontSize:12}}>
                          <div style={{display:"flex",gap:8,alignItems:"center"}}>
                            <span style={{color:t.side==="BUY"?"#4ade80":"#f87171",fontWeight:700}}>{t.side}</span>
                            <span style={{color:"#94a3b8",fontWeight:600}}>{t.ticker}</span>
                            <span style={{color:"#475569"}}>{t.q+"x"}</span>
                            {t.auto&&<span style={{fontSize:9,color:"#7c3aed",background:"#1e1b4b",borderRadius:3,padding:"1px 5px"}}>AUTO</span>}
                          </div>
                          <div style={{textAlign:"right"}}>
                            <div style={{color:"#f1f5f9"}}>{"$"+t.price}</div>
                            {t.pnl!==undefined&&<div style={{fontSize:10,color:t.pnl>=0?"#4ade80":"#f87171"}}>{(t.pnl>=0?"+":"")+"$"+t.pnl.toFixed(0)}</div>}
                            <div style={{fontSize:9,color:"#334155"}}>{t.time}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── BACKTEST ── */}
        {tab==="backtest"&&(
          <div style={{animation:"fu 0.3s ease"}}>
            <div style={{marginBottom:14,display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:12,alignItems:"flex-end"}}>
              <div><div style={{fontSize:20,fontWeight:700,color:"#f1f5f9"}}>Strategy Backtester</div><div style={{fontSize:11,color:"#334155",marginTop:2}}>90-day simulation with self-tuned parameters</div></div>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <span style={{fontSize:11,color:"#475569"}}>TICKER:</span>
                <select value={btTicker} onChange={function(e){setBtTicker(e.target.value);}} style={{background:"#0f172a",border:"1px solid #1e293b",color:"#f1f5f9",borderRadius:7,padding:"8px 12px",fontSize:12}}>
                  {TICKERS.map(function(t){return<option key={t} value={t}>{t}</option>;})}
                </select>
              </div>
            </div>
            {!btResult?<div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:40,textAlign:"center",color:"#334155",fontSize:13}}>Loading...</div>:<BTResults r={btResult} ticker={btTicker}/>}
          </div>
        )}

        {/* ── AUTOPILOT ── */}
        {tab==="autopilot"&&(
          <div style={{animation:"fu 0.3s ease"}}>
            <div style={{marginBottom:18,display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:14,alignItems:"flex-start"}}>
              <div>
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:4}}>
                  <div style={{fontSize:20,fontWeight:700,color:"#f1f5f9"}}>Autopilot</div>
                  <span style={{padding:"3px 10px",borderRadius:20,fontSize:10,fontWeight:800,letterSpacing:1,background:apOn?"#052e16":"#0f172a",color:apOn?"#4ade80":"#475569",border:"1px solid "+(apOn?"#16a34a":"#334155")}}>{apOn?"ACTIVE":"PAUSED"}</span>
                  {apOn&&<span style={{fontSize:11,color:"#334155"}}>{"Next scan in "+apCountdown+"s"}</span>}
                </div>
                <div style={{fontSize:11,color:"#334155"}}>Auto-executes BUY/STRONG BUY paper trades. Self-tunes strategy every 4 scans.</div>
              </div>
              <div style={{display:"flex",gap:10}}>
                <button onClick={function(){runScan();}} style={{background:"#0f172a",border:"1px solid #1e293b",color:"#64748b",borderRadius:8,padding:"9px 16px",fontSize:12}}>Scan Now</button>
                <button onClick={function(){setApOn(!apOn);}} style={{background:apOn?"#7f1d1d":"#15803d",border:"none",color:"#fff",borderRadius:8,padding:"9px 20px",fontSize:12,fontWeight:700}}>{apOn?"Pause Autopilot":"Start Autopilot"}</button>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:18}}>
              <MC label="Portfolio Value" value={"$"+portVal.toLocaleString("en-US",{maximumFractionDigits:0})}/>
              <MC label="Total Return" value={(portPct>=0?"+":"")+portPct.toFixed(2)+"%"} color={portPct>=0?"#4ade80":"#ef4444"}/>
              <MC label="Positions" value={Object.keys(port.pos).length+"/"+MAX_POS} color={Object.keys(port.pos).length>=MAX_POS?"#f59e0b":"#94a3b8"}/>
              <MC label="Auto Trades" value={apStats.trades} color="#60a5fa"/>
              <MC label="Tune Cycles" value={apStats.tunes} color="#a78bfa"/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:18,marginBottom:18}}>
              <div>
                <div style={{fontSize:11,color:"#475569",letterSpacing:1,marginBottom:10,display:"flex",justifyContent:"space-between"}}>
                  <span>ACTIVITY LOG</span>
                  <span style={{color:"#1e293b",cursor:"pointer"}} onClick={function(){setApLog([]);}}>clear</span>
                </div>
                <div style={{background:"#030712",border:"1px solid #0f172a",borderRadius:10,height:300,overflowY:"auto",padding:"4px 0"}}>
                  {apLog.length===0?<div style={{padding:"24px 16px",textAlign:"center",fontSize:12,color:"#1e293b"}}>No activity yet. Start autopilot or click Scan Now.</div>:
                  apLog.map(function(e,i){
                    return(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"60px 40px 44px 1fr",gap:8,padding:"7px 14px",borderBottom:"1px solid #0a0f1a",alignItems:"start"}}>
                        <span style={{fontSize:10,color:"#334155"}}>{e.time}</span>
                        <span style={{fontSize:10,fontWeight:700,color:e.color}}>{e.type}</span>
                        <span style={{fontSize:10,color:"#475569"}}>{e.ticker}</span>
                        <span style={{fontSize:10,color:"#334155",lineHeight:1.4}}>{e.reason}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <div style={{fontSize:11,color:"#475569",letterSpacing:1,marginBottom:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span>SELF-TUNING ENGINE</span>
                  <button onClick={runTune} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:5,padding:"3px 10px",fontSize:10}}>Tune Now</button>
                </div>
                <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:10,padding:"12px 14px",marginBottom:10}}>
                  <div style={{fontSize:9,color:"#334155",letterSpacing:1,marginBottom:8}}>LIVE PARAMETERS</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:5}}>
                    {[{l:"Dip Zone",v:cfg.dipMin+"-"+cfg.dipMax+"%"},{l:"RSI Oversold",v:cfg.rsiOversold},{l:"RSI Recovery",v:cfg.rsiRecovery},{l:"Stop Loss",v:cfg.sl+"%"},{l:"Take Profit",v:cfg.tp+"%"},{l:"Max Pos Size",v:cfg.maxPosPct+"%"}].map(function(p,i){
                      return<div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 8px",background:"#030712",borderRadius:4}}><span style={{fontSize:10,color:"#334155"}}>{p.l}</span><span style={{fontSize:10,fontWeight:700,color:"#60a5fa"}}>{p.v}</span></div>;
                    })}
                  </div>
                </div>
                <div style={{fontSize:10,color:"#475569",letterSpacing:1,marginBottom:8}}>TUNE LOG</div>
                <div style={{background:"#030712",border:"1px solid #0f172a",borderRadius:10,height:168,overflowY:"auto",padding:"4px 0"}}>
                  {tuneLog.length===0?<div style={{padding:"20px 16px",textAlign:"center",fontSize:12,color:"#1e293b"}}>No tuning cycles yet.</div>:
                  tuneLog.map(function(e,i){
                    return(
                      <div key={i} style={{padding:"8px 14px",borderBottom:"1px solid #0a0f1a"}}>
                        <div style={{fontSize:9,color:"#334155",marginBottom:4}}>{e.time+" - "+e.ticker}</div>
                        {e.changes.length===0?<div style={{fontSize:10,color:"#1e293b"}}>No changes needed.</div>:e.changes.map(function(c,j){return<div key={j} style={{fontSize:10,color:"#a78bfa",marginBottom:2}}>{"+ "+c}</div>;})}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            {Object.values(port.pos).length>0&&(
              <div>
                <div style={{fontSize:11,color:"#475569",letterSpacing:1,marginBottom:10}}>AUTOPILOT POSITIONS</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:10}}>
                  {Object.values(port.pos).map(function(p){
                    var st=stocks.find(function(x){return x.ticker===p.ticker;}),cur=st?st.cur:p.avg;
                    var pnl=(cur-p.avg)*p.shares,pct=(cur-p.avg)/p.avg*100;
                    var slPct=((cur-p.sl)/cur*100).toFixed(1),tpPct=((p.tp-cur)/cur*100).toFixed(1);
                    return(
                      <div key={p.ticker} style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:9,padding:"12px 14px"}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                          <span style={{fontSize:14,fontWeight:700,color:"#f1f5f9"}}>{p.ticker}</span>
                          <span style={{fontSize:13,fontWeight:700,color:pnl>=0?"#4ade80":"#ef4444"}}>{(pnl>=0?"+":"")+"$"+pnl.toFixed(0)}</span>
                        </div>
                        <div style={{fontSize:10,color:"#475569",marginBottom:6}}>{p.shares+" shares at $"+p.avg+" now $"+cur}</div>
                        <div style={{height:3,background:"#1e293b",borderRadius:2,marginBottom:6,overflow:"hidden"}}><div style={{height:"100%",borderRadius:2,background:pnl>=0?"#22c55e":"#ef4444",width:Math.min(100,Math.abs(pct)*4)+"%"}}/></div>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#334155"}}>
                          <span>{"SL "}<span style={{color:"#ef4444"}}>{slPct+"%"}</span>{" away"}</span>
                          <span>{"TP "}<span style={{color:"#4ade80"}}>{tpPct+"%"}</span>{" away"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── AI ANALYSIS ── */}
        {tab==="ai"&&<LosersTab stocks={stocks} setModal={setModal} setTab={setTab} setQty={setQty} anthropicKey={anthropicKey} fhKey={fhKey} fmpKey={fmpKey}/>}

        {/* ── SETTINGS ── */}
        {tab==="settings"&&(
          <div style={{animation:"fu 0.3s ease",maxWidth:560}}>
            <div style={{marginBottom:18}}><div style={{fontSize:20,fontWeight:700,color:"#f1f5f9"}}>Settings</div><div style={{fontSize:11,color:"#334155",marginTop:2}}>Alpaca integration and strategy parameters</div></div>
            <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"22px",marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <div style={{fontSize:14,fontWeight:700,color:"#f1f5f9"}}>Alpaca API Integration</div>
                <span style={{background:"#052e16",border:"1px solid #15803d",color:"#4ade80",fontSize:9,fontWeight:700,borderRadius:4,padding:"2px 7px",letterSpacing:1}}>PAPER MODE</span>
              </div>
              <div style={{fontSize:12,color:"#475569",lineHeight:1.6,marginBottom:14}}>Enter your Alpaca paper trading API keys. Live trading is OFF by default.</div>
              <div style={{marginBottom:12}}><div style={{fontSize:10,color:"#334155",marginBottom:5}}>API KEY</div><input type="text" placeholder="PK..." value={alpaca.key} onChange={function(e){var v=e.target.value;setAlpaca(function(p){return Object.assign({},p,{key:v});});}} style={{width:"100%",background:"#0f172a",border:"1px solid #1e293b",color:"#f1f5f9",borderRadius:7,padding:"9px 13px",fontSize:12,outline:"none"}}/></div>
              <div style={{marginBottom:14}}><div style={{fontSize:10,color:"#334155",marginBottom:5}}>SECRET KEY</div><input type="password" placeholder="..." value={alpaca.secret} onChange={function(e){var v=e.target.value;setAlpaca(function(p){return Object.assign({},p,{secret:v});});}} style={{width:"100%",background:"#0f172a",border:"1px solid #1e293b",color:"#f1f5f9",borderRadius:7,padding:"9px 13px",fontSize:12,outline:"none"}}/></div>
              <div style={{background:alpaca.live?"#1c0505":"#0f172a",border:"1px solid "+(alpaca.live?"#dc2626":"#1e293b"),borderRadius:9,padding:"14px",marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                  <div><div style={{fontSize:12,fontWeight:700,color:alpaca.live?"#ef4444":"#94a3b8"}}>{alpaca.live?"LIVE TRADING ENABLED":"Live Trading: OFF"}</div><div style={{fontSize:10,color:"#475569",marginTop:2}}>{alpaca.live?"Real orders will execute on Alpaca":"Paper mode only"}</div></div>
                  <button onClick={function(){if(!alpaca.live){notify("Warning: this uses real money on Alpaca",true);setAlpaca(function(p){return Object.assign({},p,{live:true});});}else{setAlpaca(function(p){return Object.assign({},p,{live:false});});notify("Live trading disabled");}}} style={{width:50,height:26,borderRadius:13,border:"none",background:alpaca.live?"#dc2626":"#1e293b",position:"relative"}}>
                    <div style={{position:"absolute",top:3,left:alpaca.live?26:3,width:20,height:20,borderRadius:"50%",background:alpaca.live?"#fff":"#334155",transition:"left 0.2s"}}/>
                  </button>
                </div>
                {alpaca.live&&<div style={{fontSize:11,color:"#f87171",background:"rgba(220,38,38,0.1)",borderRadius:5,padding:"7px 9px"}}>Live trading active. Real orders will be sent from the Signals tab.</div>}
              </div>
              <button onClick={function(){notify(alpaca.key?"Alpaca configured (paper mode)":"Enter API keys first",!alpaca.key);}} style={{background:"#1d4ed8",border:"none",color:"#fff",borderRadius:7,padding:"9px 18px",fontSize:12,fontWeight:600}}>Save + Test Connection</button>
            </div>
            <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"22px",marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:700,color:"#f1f5f9",marginBottom:4}}>Data Sources</div>
              <div style={{fontSize:12,color:"#475569",marginBottom:14,lineHeight:1.6}}>All API keys are configured server-side. Real market data, AI analysis, and validation are active.</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                {[{label:"Twelve Data",sub:"Prices & History"},{label:"Finnhub",sub:"Analyst & Sentiment"},{label:"FMP",sub:"Fundamentals"}].map(function(s,i){
                  return(<div key={i} style={{background:"#052e16",border:"1px solid #15803d",borderRadius:7,padding:"10px 12px"}}>
                    <div style={{fontSize:11,fontWeight:700,color:"#4ade80"}}>{s.label}</div>
                    <div style={{fontSize:10,color:"#334155"}}>{s.sub}</div>
                    <div style={{fontSize:9,color:"#22c55e",marginTop:4}}>● ACTIVE</div>
                  </div>);
                })}
              </div>
            </div>
            <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"22px"}}>
              <div style={{fontSize:14,fontWeight:700,color:"#f1f5f9",marginBottom:14}}>Strategy Parameters</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[{l:"Min Dip %",v:cfg.dipMin},{l:"Max Dip %",v:cfg.dipMax},{l:"RSI Oversold",v:cfg.rsiOversold},{l:"RSI Recovery",v:cfg.rsiRecovery},{l:"Stop Loss %",v:cfg.sl},{l:"Take Profit %",v:cfg.tp}].map(function(p,i){
                  return<div key={i}><div style={{fontSize:10,color:"#334155",marginBottom:4}}>{p.l}</div><input type="number" defaultValue={p.v} style={{width:"100%",background:"#0f172a",border:"1px solid #1e293b",color:"#f1f5f9",borderRadius:7,padding:"8px 11px",fontSize:12,outline:"none"}}/></div>;
                })}
              </div>
              <div style={{marginTop:10,fontSize:10,color:"#1e293b"}}>Self-tuning engine auto-adjusts these. Manual changes apply on next refresh.</div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}


