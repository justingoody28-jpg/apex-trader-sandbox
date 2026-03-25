// cache-bust: 1774387307998
import Head from "next/head";
import { useState, useEffect, useCallback, useRef } from "react";
import { ArbTab } from '../lib/ArbTab';
import { useAuth } from './_app';
import LoginPage from './login';
import { signOut, supabase } from '../lib/supabase';



const TICKERS = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","AXON","DDOG","SNOW","INTU","DAL","FTAI","CNC","NKE","ADBE","AMD","CRM","FICO"];
const BASE = {AAPL:185,MSFT:375,NVDA:115,AMZN:195,GOOGL:168,META:580,TSLA:275,JPM:285,AXON:498,DDOG:127,SNOW:178,INTU:412,DAL:63,FTAI:222,CNC:35,NKE:59,ADBE:380,AMD:105,CRM:285,FICO:1135};
const SECTORS = ["Technology","Technology","Semiconductors","E-Commerce","Technology","Social Media","EV","Financials","Defense Tech","Cloud","Cloud","Fintech","Airlines","Aviation","Healthcare","Apparel","Creative Software","Semiconductors","Cloud","Analytics"];
const INIT_CFG = {dipMin:5,dipMax:20,rsiOversold:35,rsiRecovery:45,volMult:1.3,sl:7,tp:20,startCash:100000,maxPosPct:18};
const MAX_POS = 5;
const FMP_KEY = "LNXhjGVvJWSSf5BCWk95BElPxVCSWxSY";
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

// Math helpers
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

// Stock generator
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

// Backtester
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

// Self-tuning engine
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

// Small UI components
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

// Charts
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

// BacktestResults component
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

// Price Chart Component
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
  var dates=[data[0].datetime, data[Math.floor(n/2)].datetime, data[n].datetime];
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

// Analyst Ratings Chart
function AnalystChart(props){
  var data=props.data;
  if(!data||!Array.isArray(data)||data.length===0)return <div style={{color:"#334155",fontSize:11,padding:"8px 0"}}>No analyst data</div>;
  var recent=data.slice(0,4).reverse();
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
              <div style={{fontSize:8,color:"#334155"}}>{d.period&&d.period.slice(0,7)||"-"}</div>
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

function runDeepDive(stock,setResult,setLoading){
  setLoading(true);setResult(null);
  var name=stock.name||stock.ticker;
  fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1200,system:"You are a rigorous financial analyst. Return ONLY valid JSON.",messages:[{role:"user",content:"Today is "+new Date().toDateString()+". Deep dive: "+stock.ticker+" ("+name+"). Price: "+stock.price+", DIP: "+(stock.dropNum||0)+"% from 52W high, Analyst target: "+(stock.analystTarget||"N/A")+", Upside: "+(stock.upside||"N/A")+", Analyst buy: "+(stock.analystBuyPct!=null?stock.analystBuyPct+"%":"N/A")+". Initial verdict: "+stock.verdict+", Rec: "+stock.recommendation+". VERIFY: 1) Is analyst target above or below price? 2) Drop from hype or fundamentals? 3) Real deterioration or sentiment? 4) Timeframe decel or continuation? If verdict wrong say so explicitly. Return JSON: {verdict,recommendation,confidence,verdictChanged,changeReason,keyRisks,keyOpportunities,priceTargetAnalysis,finalCall,suggestedEntry,suggestedStop}"}]})}).then(function(r){return r.json();})
  .then(function(d){var raw=(d.content||[]).map(function(b){return b.text||"";}).join("");var clean=raw.replace(/```json|```/g,"").trim();var s=clean.indexOf("{"),e=clean.lastIndexOf("}");setResult(s>-1&&e>-1?JSON.parse(clean.slice(s,e+1)):{error:"parse failed"});setLoading(false);})
  .catch(function(){setLoading(false);});
}

function calcDataScore(d){
  var checks=[],score=0;
  var price=parseFloat((d.price||"0").toString().replace(/[^0-9.]/g,""))||0;
  var target=parseFloat((d.analystTarget||"0").toString().replace(/[^0-9.]/g,""))||0;
  var buyPct=parseFloat(d.analystBuyPct)||0;
  var pe=parseFloat(d.pe)||0;
  var dip=parseFloat(d.dip)||0;
  var c1W=parseFloat(d.change1W)||0;
  var c1M=parseFloat(d.change1M)||0;
  var beta=parseFloat(d.beta||0);
  var dipOk=dip>=5&&dip<=20;
  checks.push({label:"DIP 5-20%",pass:dipOk,pts:dipOk?20:0,max:20,value:dip.toFixed(1)+"%"});
  if(dipOk) score+=20;
  var tOk=target>0&&price>0&&target>=price*1.10;
  checks.push({label:"Target 10%+ upside",pass:tOk,pts:tOk?20:0,max:20,value:target>0?"$"+target.toFixed(0):"N/A"});
  if(tOk) score+=20;
  var bOk=buyPct>=60;
  checks.push({label:"Analyst buy >60%",pass:bOk,pts:bOk?15:0,max:15,value:buyPct>0?buyPct+"%":"N/A"});
  if(bOk) score+=15;
  var pOk=pe>0&&pe<50;
  checks.push({label:"P/E 0-50",pass:pOk,pts:pOk?15:0,max:15,value:pe>0?pe.toFixed(1):"N/A"});
  if(pOk) score+=15;
  var dOk=c1W!==0&&c1M!==0&&Math.abs(c1W)<Math.abs(c1M)&&c1M<0;
  checks.push({label:"Selling decelerating",pass:dOk,pts:dOk?15:0,max:15,value:c1M.toFixed(1)+"% / "+c1W.toFixed(1)+"%"});
  if(dOk) score+=15;
  var nOk=c1M>-30;
  checks.push({label:"No freefall <30%",pass:nOk,pts:nOk?10:0,max:10,value:c1M.toFixed(1)+"%"});
  if(nOk) score+=10;
  var betaOk=beta>0&&beta<2;
  checks.push({label:"Beta < 2",pass:betaOk,pts:betaOk?5:0,max:5,value:beta>0?beta.toFixed(2):"N/A"});
  if(betaOk) score+=5;
  return{score:Math.min(100,score),checks:checks};
}

function LosersTab(props){
  var SECTORS_LIST=[
    {id:"Technology",label:"Technology",icon:"ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ»"},
    {id:"Healthcare",label:"Healthcare",icon:"ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ¥"},
    {id:"Financial Services",label:"Financials",icon:"ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ¦"},
    {id:"Energy",label:"Energy",icon:"ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ¡"},
    {id:"Consumer Cyclical",label:"Consumer Cyclical",icon:"ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂ¸ÃÂÃÂ"},
    {id:"Industrials",label:"Industrials",icon:"ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ­"},
    {id:"Communication Services",label:"Communication",icon:"ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ¡"},
    {id:"Basic Materials",label:"Materials",icon:"ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂ¸ÃÂÃÂ"},
    {id:"Consumer Defensive",label:"Consumer Staples",icon:"ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ"},
    {id:"Real Estate",label:"Real Estate",icon:"ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ¢"},
    {id:"Utilities",label:"Utilities",icon:"ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ¡"},
  ];
  var TIMEFRAMES=[
    {id:"1W",label:"1 Week",days:7},
    {id:"1M",label:"1 Month",days:30},
    {id:"3M",label:"3 Months",days:90},
    {id:"6M",label:"6 Months",days:180},
    {id:"52W",label:"52 Weeks",days:365},
  ];
  function screenerSig(ticker){
    var s=(props.stocks||[]).find(function(x){return x.ticker===ticker;});
    return s?s.sig:null;
  }

  var [sector,setSector]=useState("Technology");
  var [timeframe,setTimeframe]=useState("3M");
  var [marketCap,setMarketCap]=useState("all");
  var [loading,setLoading]=useState(false);
  var [error,setError]=useState(null);
  var [results,setResults]=useState([]);
  var [summary,setSummary]=useState(null);
  var [filter,setFilter]=useState("all");
  var [expanded,setExpanded]=useState({});
  var [chartData,setChartData]=useState({});
  var [ratingsData,setRatingsData]=useState({});
  var [validationCache,setValidationCache]=useState({});
  var [validating,setValidating]=useState(false);
  var [watchlist,setWatchlist]=useState([]);
  var [searchTicker,setSearchTicker]=useState("");
  var [searchResult,setSearchResult]=useState(null);
  var [searchLoading,setSearchLoading]=useState(false);
  var [searchError,setSearchError]=useState(null);
  var [deepDiveStock,setDeepDiveStock]=useState(null);
  var [deepDiveResult,setDeepDiveResult]=useState(null);
  var [deepDiveLoading,setDeepDiveLoading]=useState(false);

  function loadWatchlist(){fetch("/api/portfolio?action=watchlist").then(function(r){return r.json();}).then(function(d){setWatchlist(Array.isArray(d)?d:[]);}).catch(function(){});}
  useEffect(function(){loadWatchlist();},[]);
  function addToWatchlist(ticker,name){fetch("/api/portfolio?action=watchlist_add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker,name,added_from:"ai_analysis"})}).then(function(){loadWatchlist();});}
  function removeFromWatchlist(ticker){fetch("/api/portfolio?action=watchlist_remove",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker})}).then(function(){loadWatchlist();});}

  function loadTrends(ticker){
    fetch("/api/market?source=td&endpoint=time_series?symbol="+ticker+"&interval=1day&outputsize=90")
      .then(function(r){return r.json();}).then(function(d){if(d.values)setChartData(function(p){var n=Object.assign({},p);n[ticker]=d.values.slice().reverse();return n;});}).catch(function(){});
    fetch("/api/market?source=fh&endpoint=stock/recommendation?symbol="+ticker)
      .then(function(r){return r.json();}).then(function(d){if(Array.isArray(d))setRatingsData(function(p){var n=Object.assign({},p);n[ticker]=d;return n;});}).catch(function(){});
  }
  function toggleExpand(ticker,field){setExpanded(function(p){var c=Object.assign({},p[ticker]||{});c[field]=!c[field];if(c[field])loadTrends(ticker);return Object.assign({},p,{[ticker]:c});});}

  function runAnalysis(){
    setLoading(true);setError(null);setResults([]);setSummary(null);setValidationCache({});
    var tf=TIMEFRAMES.find(function(t){return t.id===timeframe;})||TIMEFRAMES[2];
    var toDate=new Date(),fromDate=new Date(toDate-tf.days*24*60*60*1000);
    var fromStr=fromDate.toISOString().slice(0,10),toStr=toDate.toISOString().slice(0,10);
    var capFilters="";
    if(marketCap==="large")capFilters="&marketCapMoreThan=10000000000";
    else if(marketCap==="mid")capFilters="&marketCapMoreThan=1000000000&marketCapLowerThan=10000000000";
    else if(marketCap==="small")capFilters="&marketCapMoreThan=100000000&marketCapLowerThan=1000000000";
    else capFilters="&marketCapMoreThan=100000000";
    fetch("/api/market?source=fmp&endpoint=company-screener&sector="+encodeURIComponent(sector)+"&exchange=NYSE%2CNASDAQ"+capFilters+"&limit=50&isActivelyTrading=true")
      .then(function(r){return r.json();})
      .then(function(screenerData){
        if(!Array.isArray(screenerData)||screenerData.length===0){
          setError("No stocks found for "+sector+". Try a different sector.");
          setLoading(false);return;
        }
        var top20=screenerData.slice(0,20).map(function(s){return s.symbol;});
        return Promise.all(top20.map(function(sym){
          return fetch("/api/market?source=fmp&endpoint=historical-price-eod/full&symbol="+sym+"&from="+fromStr+"&to="+toStr)
            .then(function(r){return r.json();}).catch(function(){return [];});
        }))
          .then(function(results){
            var histData=[].concat.apply([],results.map(function(r){return Array.isArray(r)?r:[];}));
            var perfByTicker={};
            if(Array.isArray(histData)){
              var grouped={};
              histData.forEach(function(row){
                if(!grouped[row.symbol])grouped[row.symbol]=[];
                grouped[row.symbol].push(row);
              });
              Object.keys(grouped).forEach(function(sym){
                var rows=grouped[sym].sort(function(a,b){return new Date(a.date)-new Date(b.date);});
                if(rows.length>=2){
                  var first=rows[0].close,last=rows[rows.length-1].close;
                  var pct=((last-first)/first*100);
                  perfByTicker[sym]={change:+pct.toFixed(2),from:rows[0].date,to:rows[rows.length-1].date,prices:rows.map(function(r){return r.close;})};
                }
              });
            }
            var topLosers=Object.keys(perfByTicker)
              .filter(function(t){return perfByTicker[t].change<0;})
              .sort(function(a,b){return perfByTicker[a].change-perfByTicker[b].change;})
              .slice(0,12);
            if(topLosers.length===0){
              setError("No losers found in "+sector+" over "+tf.label+". Market may be up across this sector.");
              setLoading(false);return;
            }
            var tfDefs=[{id:"1W",days:7},{id:"1M",days:30},{id:"3M",days:90},{id:"6M",days:180},{id:"52W",days:365}];
            var allTfFetches=tfDefs.map(function(tfd){
              var tfFrom=new Date(new Date()-tfd.days*24*60*60*1000).toISOString().slice(0,10);
              return Promise.all(topLosers.map(function(sym){
                return fetch("/api/market?source=fmp&endpoint=historical-price-eod/full&symbol="+sym+"&from="+tfFrom+"&to="+toStr)
                  .then(function(r){return r.json();}).catch(function(){return [];});
              })).then(function(results){return [].concat.apply([],results.map(function(r){return Array.isArray(r)?r:[];}));});
            });
            var fhFetches=topLosers.map(function(t){
              return Promise.all([
                fetch("/api/market?source=fmp_fh&endpoint=quote&fh_endpoint=quote&symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
                fetch("/api/market?source=fh&endpoint=stock/recommendation?symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
                fetch("/api/market?source=fh&endpoint=stock/price-target?symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
              ]).then(function(res){
                var q=res[0];
                var synthMetric=q&&q.hi52?{metric:{"52WeekHigh":q.hi52,"52WeekLow":q.lo52,"peExclExtraTTM":q.pe,"beta":q.beta}}:null;
                return {ticker:t,quote:q,metric:synthMetric,rec:res[1],pt:res[2]};
              });
            });
            return Promise.all([Promise.all(allTfFetches),Promise.all(fhFetches),Promise.resolve(screenerData),Promise.resolve(perfByTicker),Promise.resolve(topLosers)]);
          });
      })
      .then(function(allData){
        if(!allData)return;
        var allTfData=allData[0],fhData=allData[1],screenerData=allData[2],perfByTicker=allData[3],topLosers=allData[4];
        var tfDefs=[{id:"1W",days:7},{id:"1M",days:30},{id:"3M",days:90},{id:"6M",days:180},{id:"52W",days:365}];
        var tfPerfByTicker={};
        allTfData.forEach(function(histArr,tfIdx){
          if(!Array.isArray(histArr))return;
          var grouped={};
          histArr.forEach(function(row){if(!grouped[row.symbol])grouped[row.symbol]=[];grouped[row.symbol].push(row);});
          Object.keys(grouped).forEach(function(sym){
            var rows=grouped[sym].sort(function(a,b){return new Date(a.date)-new Date(b.date);});
            if(rows.length>=2){
              if(!tfPerfByTicker[sym])tfPerfByTicker[sym]={};
              tfPerfByTicker[sym][tfDefs[tfIdx].id]=+((rows[rows.length-1].close-rows[0].close)/rows[0].close*100).toFixed(2);
            }
          });
        });
        var fhByTicker={};
        fhData.forEach(function(d){fhByTicker[d.ticker]=d;});
        var stocksForClaude=topLosers.map(function(t){
          var sp=screenerData.find(function(s){return s.symbol===t;})||{};
          var fh=fhByTicker[t]||{};
          var tf_perf=tfPerfByTicker[t]||{};
          var cur=fh.quote&&fh.quote.c?fh.quote.c:sp.price||0;
          var hi52=fh.metric&&fh.metric.metric&&fh.metric.metric["52WeekHigh"]?fh.metric.metric["52WeekHigh"]:null;
          var lo52=fh.metric&&fh.metric.metric&&fh.metric.metric["52WeekLow"]?fh.metric.metric["52WeekLow"]:null;
          var pe=fh.metric&&fh.metric.metric?fh.metric.metric["peExclExtraTTM"]:null;
          var beta=fh.metric&&fh.metric.metric?fh.metric.metric["beta"]:null;
          var analystTarget=fh.pt&&fh.pt.targetMean?fh.pt.targetMean:null;
          var rec=fh.rec&&Array.isArray(fh.rec)&&fh.rec.length>0?fh.rec[0]:null;
          var buyPct=rec?Math.round(((rec.buy||0)+(rec.strongBuy||0))/((rec.buy||0)+(rec.hold||0)+(rec.sell||0)+(rec.strongBuy||0)+(rec.strongSell||0)||1)*100):null;
          return {
            symbol:t,name:sp.companyName||t,
            price:cur.toFixed(2),
            marketCap:sp.marketCap?("$"+(sp.marketCap/1e9).toFixed(1)+"B"):null,
            hi52:hi52?hi52.toFixed(2):null,lo52:lo52?lo52.toFixed(2):null,
            pe:pe?pe.toFixed(1):null,beta:beta?beta.toFixed(2):null,
            analystTarget:analystTarget?analystTarget.toFixed(0):null,
            analystUpside:analystTarget&&cur>0?(((analystTarget-cur)/cur)*100).toFixed(0):null,
            analystBuyPct:buyPct,
            performance:{
              "1W":tf_perf["1W"]!==undefined?tf_perf["1W"]:null,
              "1M":tf_perf["1M"]!==undefined?tf_perf["1M"]:null,
              "3M":tf_perf["3M"]!==undefined?tf_perf["3M"]:null,
              "6M":tf_perf["6M"]!==undefined?tf_perf["6M"]:null,
              "52W":tf_perf["52W"]!==undefined?tf_perf["52W"]:null,
            },
            selectedTf:timeframe,
            selectedTfChange:tf_perf[timeframe]||perfByTicker[t]&&perfByTicker[t].change||null
          };
        });
        var sectorLabel=SECTORS_LIST.find(function(s){return s.id===sector;})||{label:sector};
        var tfLabel=TIMEFRAMES.find(function(t){return t.id===timeframe;})||{label:timeframe};
        var prompt="Today is "+new Date().toDateString()+". I am analyzing the "+sectorLabel.label+" sector. "+
          "These are the actual biggest losers in "+sectorLabel.label+" over the last "+tfLabel.label+", based on real FMP market data:"+
          stocksForClaude.map(function(s){
            var perf=Object.entries(s.performance).filter(function(e){return e[1]!==null;}).map(function(e){return e[0]+": "+(e[1]>0?"+":"")+e[1]+"%";}).join(", ");
            return s.symbol+" ("+s.name+"): $"+s.price+
              (s.marketCap?" | MktCap "+s.marketCap:"")+
              " | Performance: "+perf+
              (s.pe?" | P/E "+s.pe:"")+
              (s.beta?" | Beta "+s.beta:"")+
              (s.analystTarget?" | Analyst Target $"+s.analystTarget+" ("+s.analystUpside+"% upside, "+s.analystBuyPct+"% analyst buy)":"")+
              (s.hi52?" | 52W Range $"+s.lo52+" to $"+s.hi52:"");
          }).join("\n")+
          "\n\nFor each stock, analyze the multi-timeframe performance pattern to determine:\n"+
          "1. WHAT caused the drop at each timeframe (different events = different timeframes)\n"+
          "2. Whether selling is ACCELERATING (recent TF worse than longer TF) or DECELERATING (most damage is old)\n"+
          "3. Recovery PROBABILITY (High/Medium/Low) and estimated TIMELINE based on the pattern\n"+
          "4. Whether this is a buying opportunity or a falling knife"+
          "Return a JSON array of exactly "+stocksForClaude.length+" objects. Each must have:"+
          "ticker, name, sector, verdict (Strong Overreaction|Overreaction|Partial Overreaction|Mixed|Justified),"+
          "selectedTfChange (e.g. -18.4%), dropNum (negative number),"+
          "price (e.g. $142), marketCap,"+
          "catalyst (2 sentences on what caused the drop),"+
          "multiTfAnalysis (2 sentences on the multi-timeframe pattern),"+
          "recoveryProbability (High|Medium|Low),"+
          "recoveryTimeline (e.g. 4-8 weeks or 3-6 months or unclear),"+
          "bull (2 sentences), bear (2 sentences),"+
          "analystTarget, upside (e.g. +42%), upsideNum (number),"+
          "recommendation (Strong Buy|Buy|Watch|Avoid)";

        fetch("/api/analyze",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({
            model:"claude-sonnet-4-20250514",max_tokens:6000,
            system:"You are a financial data API. Your ENTIRE response must be a valid JSON array starting with [ and ending with ]. No text before or after. No markdown fences.",
            messages:[{role:"user",content:prompt},{role:"assistant",content:"[{"}]
          }),
        }).then(function(r){return r.json();})
        .then(function(data){
          if(data.error)throw new Error(data.error.message||"API error");
          var raw=(data.content||[]).map(function(b){return b.text||"";}).join("");
          var combined="[{"+raw;
          var clean=combined.replace(/```json/g,"").replace(/```/g,"").trim();
          var s2=clean.indexOf("["),e2=clean.lastIndexOf("]");
          if(s2===-1||e2===-1)throw new Error("No JSON array found");
          var parsed=JSON.parse(clean.slice(s2,e2+1));
          var realDataMap={};
          stocksForClaude.forEach(function(s){realDataMap[s.symbol]=s;});
          parsed.forEach(function(s){
            var real=realDataMap[s.ticker]||{};
            var rt=real.analystTarget?parseFloat(real.analystTarget):null;
            var rp=real.price?parseFloat(real.price):null;
            if(rt&&rt>0){
              s.analystTarget="$"+rt.toFixed(0);
              if(rp&&rp>0){
                var u=+((rt-rp)/rp*100).toFixed(0);
                s.upsideNum=u;
                s.upside=(u>=0?"+":"")+u+"%";
                if(rt<rp*0.97){s.recommendation="Avoid";if(s.verdict==="Strong Overreaction"||s.verdict==="Overreaction")s.verdict="Justified";}
              }
            }
            if(real.analystBuyPct!=null) s.analystBuyPct=real.analystBuyPct;
            var ds=calcDataScore({price:s.price,analystTarget:s.analystTarget,analystBuyPct:real.analystBuyPct,pe:real.pe,dip:real.selectedTfChange?Math.abs(real.selectedTfChange):s.dropNum?Math.abs(s.dropNum):0,change1W:real.performance&&real.performance["1W"]!=null?real.performance["1W"]:0,change1M:real.performance&&real.performance["1M"]!=null?real.performance["1M"]:0,beta:real.beta});
            s.dataScore=ds.score;
            s.dataChecks=ds.checks;
          });
          setResults(parsed);
          var over=parsed.filter(function(s){return s.verdict==="Strong Overreaction"||s.verdict==="Overreaction";}).length;
          var highProb=parsed.filter(function(s){return s.recoveryProbability==="High";}).length;
          var avgDrop=(parsed.reduce(function(sum,s){return sum+(s.dropNum||0);},0)/parsed.length).toFixed(1);
          setSummary({sector:sectorLabel.label,tf:tfLabel.label,total:parsed.length,over,highProb,avgDrop});
          setLoading(false);
          fetch("/api/portfolio?action=ai_analysis",{
            method:"POST",headers:{"Content-Type":"application/json"},
            body:JSON.stringify({results:parsed,category:sector+"_"+timeframe})
          }).catch(function(){});
        })
        .catch(function(err){setLoading(false);setError("Analysis failed: "+err.message);});
      })
      .catch(function(err){setLoading(false);setError("Data fetch failed: "+err.message);});
  }

  function runSearch(){
    var t=searchTicker.trim().toUpperCase();
    if(!t)return;
    setSearchLoading(true);setSearchError(null);setSearchResult(null);
    var today=new Date(),from90=new Date(today-365*24*60*60*1000);
    var fromStr=from90.toISOString().slice(0,10),toStr=today.toISOString().slice(0,10);
    Promise.all([
      fetch("/api/market?source=fmp&endpoint=historical-price-eod/full&symbol="+t+"&from="+fromStr+"&to="+toStr).then(function(r){return r.json();}).catch(function(){return null;}),
      fetch("/api/market?source=fmp_fh&endpoint=quote&fh_endpoint=quote&symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
      fetch("/api/market?source=fh&endpoint=stock/recommendation?symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
      fetch("/api/market?source=fh&endpoint=stock/price-target?symbol="+t).then(function(r){return r.json();}).catch(function(){return null;}),
    ]).then(function(res){
      var hist=res[0],q=res[1],rec=res[2],pt=res[3];
      var m=q&&q.hi52?{metric:{"52WeekHigh":q.hi52,"52WeekLow":q.lo52,"peExclExtraTTM":q.pe,"beta":q.beta}}:null;
      var cur=q&&q.c?q.c:0;
      if(!cur){setSearchLoading(false);setSearchError("No data found for "+t+". Check the ticker symbol.");return;}
      var rows=Array.isArray(hist)?hist.sort(function(a,b){return new Date(a.date)-new Date(b.date);}):[];
      function calcTfChange(days){
        var cutoff=new Date(new Date()-days*24*60*60*1000);
        var filtered=rows.filter(function(r){return new Date(r.date)>=cutoff;});
        if(filtered.length<2)return null;
        return +((filtered[filtered.length-1].close-filtered[0].close)/filtered[0].close*100).toFixed(2);
      }
      var tfPerf={"1W":calcTfChange(7),"1M":calcTfChange(30),"3M":calcTfChange(90),"6M":calcTfChange(180),"52W":calcTfChange(365)};
      var hi52=m&&m.metric&&m.metric["52WeekHigh"]?m.metric["52WeekHigh"]:null;
      var lo52=m&&m.metric&&m.metric["52WeekLow"]?m.metric["52WeekLow"]:null;
      var pe=m&&m.metric?m.metric["peExclExtraTTM"]:null;
      var beta=m&&m.metric?m.metric["beta"]:null;
      var analystTarget=pt&&pt.targetMean?pt.targetMean:null;
      var recData=Array.isArray(rec)&&rec.length>0?rec[0]:null;
      var buyPct=recData?Math.round(((recData.buy||0)+(recData.strongBuy||0))/((recData.buy||0)+(recData.hold||0)+(recData.sell||0)+(recData.strongBuy||0)+(recData.strongSell||0)||1)*100):null;
      var perfStr=Object.entries(tfPerf).filter(function(e){return e[1]!==null;}).map(function(e){return e[0]+": "+(e[1]>0?"+":"")+e[1]+"%";}).join(", ");
      var prompt="Today is "+new Date().toDateString()+". Analyze "+t+" in depth. "+
        "Real market data: Price $"+cur.toFixed(2)+
        (hi52?" | 52W: $"+lo52.toFixed(2)+" to $"+hi52.toFixed(2):"")+
        (pe?" | P/E "+pe.toFixed(1):"")+
        (beta?" | Beta "+beta.toFixed(2):"")+
        (analystTarget?" | Analyst target $"+analystTarget.toFixed(0)+" ("+buyPct+"% analyst buy)":"")+
        " | Multi-timeframe performance: "+perfStr+" "+
        "Analyze the timeframe pattern: is selling accelerating or decelerating? What likely caused drops at different periods? "+
        "Return a JSON object with fields: ticker, name, sector, exchange, price (string), marketCap (string), "+
        "fiftyTwoWeekHigh, fiftyTwoWeekLow, verdict (Strong Overreaction|Overreaction|Partial Overreaction|Mixed|Justified|Fairly Valued|Overvalued), "+
        "catalyst (2 sentences), multiTfAnalysis (2 sentences on pattern), "+
        "recoveryProbability (High|Medium|Low), recoveryTimeline (string), "+
        "bull (3 sentences), bear (3 sentences), "+
        "analystTarget (string), upside (string), upsideNum (number), "+
        "peRatio (string), revenueGrowth (string), "+
        "recommendation (Strong Buy|Buy|Watch|Avoid), summary (3 sentences)";
      fetch("/api/analyze",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",max_tokens:2000,
          system:"You are a financial data API. Your ENTIRE response must be a valid JSON object starting with { and ending with }. No text before or after. No markdown fences.",
          messages:[{role:"user",content:prompt},{role:"assistant",content:"{"}]
        }),
      }).then(function(r){return r.json();})
      .then(function(data){
        if(data.error)throw new Error(data.error.message||"API error");
        var raw=(data.content||[]).map(function(b){return b.text||"";}).join("");
        var combined="{"+raw;
        var clean=combined.replace(/```json/g,"").replace(/```/g,"").trim();
        var s2=clean.indexOf("{"),e2=clean.lastIndexOf("}");
        if(s2===-1||e2===-1)throw new Error("No JSON found");
        var parsed=JSON.parse(clean.slice(s2,e2+1));
        parsed._tfPerf=tfPerf;
        setSearchResult(parsed);setSearchLoading(false);
        fetch("/api/portfolio?action=ai_analysis",{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({results:[Object.assign({},parsed,{dropNum:parsed.upsideNum||0,drop:parsed.upside||"N/A"})],category:"search"})
        }).catch(function(){});
      })
      .catch(function(err){setSearchLoading(false);setSearchError("Analysis failed: "+err.message);});
    });
  }

  var VS2={"Strong Overreaction":{c:"#4ade80",bg:"#052e16",b:"#16a34a",dot:"#22c55e"},"Overreaction":{c:"#86efac",bg:"#052e16",b:"#15803d",dot:"#4ade80"},"Partial Overreaction":{c:"#fcd34d",bg:"#1c1917",b:"#d97706",dot:"#f59e0b"},"Mixed":{c:"#94a3b8",bg:"#0f172a",b:"#334155",dot:"#64748b"},"Justified":{c:"#f87171",bg:"#1c0505",b:"#b91c1c",dot:"#ef4444"},"Fairly Valued":{c:"#60a5fa",bg:"#0c1a2e",b:"#1e3a5f",dot:"#3b82f6"},"Overvalued":{c:"#fb923c",bg:"#1c0a00",b:"#9a3412",dot:"#f97316"}};
  var tfCurrent=TIMEFRAMES.find(function(t){return t.id===timeframe;})||TIMEFRAMES[2];
  var sectorCurrent=SECTORS_LIST.find(function(s){return s.id===sector;})||SECTORS_LIST[0];
  var shown=results.filter(function(l){if(filter==="all")return true;if(filter==="buy")return l.recommendation==="Strong Buy"||l.recommendation==="Buy";if(filter==="watch")return l.recommendation==="Watch";if(filter==="avoid")return l.recommendation==="Avoid";return true;});

  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20,flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:22,fontWeight:800,color:"#f1f5f9",marginBottom:4}}>AI Analysis</div>
          <div style={{fontSize:11,color:"#334155",marginTop:3}}>Real sector data from FMP + multi-timeframe analysis via Claude</div>
        </div>
        {results.length>0&&!loading&&(
          <button onClick={runAnalysis} disabled={loading} style={{background:"#1d4ed8",border:"none",color:"#fff",borderRadius:9,padding:"11px 22px",fontSize:13,fontWeight:700,cursor:"pointer"}}>
            Rerun Analysis
          </button>
        )}
      </div>

      {/* Search Bar */}
      <div style={{background:"#0a0f1a",border:"1px solid #1e293b",borderRadius:12,padding:"14px 16px",marginBottom:16}}>
        <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:8}}>ANALYZE ANY STOCK</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input value={searchTicker} onChange={function(e){setSearchTicker(e.target.value.toUpperCase());setSearchResult(null);setSearchError(null);}}
            onKeyDown={function(e){if(e.key==="Enter")runSearch();}}
            placeholder="Enter ticker e.g. AAPL, NVDA, META..."
            style={{flex:1,background:"#030712",border:"1px solid #1e293b",borderRadius:8,padding:"10px 14px",color:"#f1f5f9",fontSize:13,outline:"none",fontFamily:"inherit"}}
          />
          <button onClick={runSearch} disabled={searchLoading||!searchTicker.trim()}
            style={{background:searchLoading||!searchTicker.trim()?"#1e293b":"linear-gradient(135deg,#1d4ed8,#7c3aed)",border:"none",color:searchLoading||!searchTicker.trim()?"#475569":"#fff",borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:700,cursor:searchLoading||!searchTicker.trim()?"not-allowed":"pointer",whiteSpace:"nowrap"}}>
            {searchLoading?"Analyzing...":"Analyze"}
          </button>
          {searchResult&&<button onClick={function(){setSearchResult(null);setSearchTicker("");}} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:8,padding:"10px 14px",fontSize:12,cursor:"pointer"}}>Clear</button>}
        </div>
        {searchError&&<div style={{marginTop:8,fontSize:11,color:"#f87171"}}>{searchError}</div>}
      </div>

      {searchLoading&&<div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"20px 22px",marginBottom:16,display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:16,height:16,border:"2px solid #1e293b",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
        <div style={{fontSize:13,color:"#f1f5f9",fontWeight:600}}>Fetching real market data for {searchTicker}...</div>
      </div>}

      {searchResult&&!searchLoading&&(function(){
        var sr=searchResult,v=VS2[sr.verdict]||VS2["Mixed"];
        var rc2=sr.recommendation==="Strong Buy"?"#22c55e":sr.recommendation==="Buy"?"#4ade80":sr.recommendation==="Watch"?"#f59e0b":"#f87171";
        return(
          <div style={{background:"#0a0f1a",border:"1px solid "+v.b,borderRadius:14,padding:"20px 22px",marginBottom:16,animation:"fu 0.3s ease both"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
              <div style={{display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                <div><div style={{fontSize:26,fontWeight:800,color:"#f1f5f9"}}>{sr.ticker}</div><div style={{fontSize:12,color:"#475569",marginTop:2}}>{sr.name}</div></div>
                <div><div style={{fontSize:20,fontWeight:700,color:"#94a3b8"}}>{sr.price}</div><div style={{fontSize:10,color:"#334155",marginTop:2}}>{sr.sector}</div></div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:800,background:v.bg,color:v.c,border:"1px solid "+v.b,display:"flex",alignItems:"center",gap:6}}><span style={{width:7,height:7,borderRadius:"50%",background:v.dot,display:"inline-block"}}/>{sr.verdict}</span>
                <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:700,background:"#0f172a",border:"1px solid #1e293b",color:rc2}}>{sr.recommendation}</span>
              </div>
            </div>
            {sr._tfPerf&&<div style={{background:"#030712",border:"1px solid #0f172a",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
              <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:8}}>MULTI-TIMEFRAME PERFORMANCE</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {Object.entries(sr._tfPerf).filter(function(e){return e[1]!==null;}).map(function(e,i){
                  var neg=e[1]<0;
                  return(<div key={i} style={{background:neg?"#1c0505":"#052e16",border:"1px solid "+(neg?"#7f1d1d":"#14532d"),borderRadius:6,padding:"6px 10px",textAlign:"center"}}>
                    <div style={{fontSize:9,color:"#64748b",marginBottom:3}}>{e[0]}</div>
                    <div style={{fontSize:13,fontWeight:700,color:neg?"#f87171":"#4ade80"}}>{e[1]>0?"+":""}{e[1]}%</div>
                  </div>);
                })}
              </div>
            </div>}
            {sr.multiTfAnalysis&&<div style={{background:"#030712",border:"1px solid "+v.b,borderRadius:8,padding:"12px 14px",marginBottom:12}}>
              <div style={{fontSize:9,color:v.c,letterSpacing:2,marginBottom:6,fontWeight:700}}>TIMEFRAME PATTERN</div>
              <div style={{fontSize:13,color:"#e2e8f0",lineHeight:1.7}}>{sr.multiTfAnalysis}</div>
            </div>}
            <div style={{background:"#030712",border:"1px solid #0f172a",borderRadius:8,padding:"10px 14px",marginBottom:12}}>
              <span style={{fontSize:9,color:"#334155",letterSpacing:2,marginRight:10}}>CATALYST</span>
              <span style={{fontSize:12,color:"#94a3b8"}}>{sr.catalyst}</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              <div style={{background:"#030e05",border:"1px solid #14532d",borderRadius:8,padding:"12px 14px"}}><div style={{fontSize:9,color:"#16a34a",letterSpacing:2,fontWeight:700,marginBottom:7}}>BULL CASE</div><div style={{fontSize:12,color:"#86efac",lineHeight:1.6}}>{sr.bull}</div></div>
              <div style={{background:"#0e0303",border:"1px solid #7f1d1d",borderRadius:8,padding:"12px 14px"}}><div style={{fontSize:9,color:"#b91c1c",letterSpacing:2,fontWeight:700,marginBottom:7}}>BEAR CASE</div><div style={{fontSize:12,color:"#fca5a5",lineHeight:1.6}}>{sr.bear}</div></div>
            </div>
            <div style={{display:"flex",gap:8}}>
              {watchlist.find(function(w){return w.ticker===sr.ticker;})?
                <button onClick={function(){removeFromWatchlist(sr.ticker);}} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>In Watchlist</button>:
                <button onClick={function(){addToWatchlist(sr.ticker,sr.name);}} style={{background:"transparent",border:"1px solid #1d4ed8",color:"#60a5fa",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>+ Add to Screener</button>
              }
            </div>
          </div>
        );
      })()}

      {/* Sector + Timeframe Controls */}
      <div style={{background:"#0a0f1a",border:"1px solid #1e293b",borderRadius:12,padding:"16px 18px",marginBottom:16}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:14}}>
          <div>
            <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:6}}>SECTOR</div>
            <select value={sector} onChange={function(e){setSector(e.target.value);setResults([]);setSummary(null);}}
              style={{width:"100%",background:"#030712",border:"1px solid #1e293b",borderRadius:6,padding:"8px 10px",color:"#f1f5f9",fontSize:12,cursor:"pointer",outline:"none"}}>
              {SECTORS_LIST.map(function(s){return <option key={s.id} value={s.id}>{s.icon} {s.label}</option>;})}
            </select>
          </div>
          <div>
            <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:6}}>TIMEFRAME</div>
            <select value={timeframe} onChange={function(e){setTimeframe(e.target.value);setResults([]);setSummary(null);}}
              style={{width:"100%",background:"#030712",border:"1px solid #1e293b",borderRadius:6,padding:"8px 10px",color:"#f1f5f9",fontSize:12,cursor:"pointer",outline:"none"}}>
              {TIMEFRAMES.map(function(t){return <option key={t.id} value={t.id}>{t.label}</option>;})}
            </select>
          </div>
          <div>
            <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:6}}>MARKET CAP</div>
            <select value={marketCap} onChange={function(e){setMarketCap(e.target.value);setResults([]);setSummary(null);}}
              style={{width:"100%",background:"#030712",border:"1px solid #1e293b",borderRadius:6,padding:"8px 10px",color:"#f1f5f9",fontSize:12,cursor:"pointer",outline:"none"}}>
              <option value="all">All Sizes</option>
              <option value="large">Large Cap ($10B+)</option>
              <option value="mid">Mid Cap ($1B-$10B)</option>
              <option value="small">Small Cap ($100M-$1B)</option>
            </select>
          </div>
        </div>
        <button onClick={runAnalysis} disabled={loading}
          style={{width:"100%",background:loading?"#1e293b":"linear-gradient(135deg,#1d4ed8,#7c3aed)",border:"none",color:loading?"#475569":"#fff",borderRadius:9,padding:"13px",fontSize:14,fontWeight:700,cursor:loading?"not-allowed":"pointer"}}>
          {loading?"Fetching real data + analyzing...":"Find Biggest Losers in "+sectorCurrent.label+" ("+tfCurrent.label+")"}
        </button>
      </div>

      {error&&<div style={{background:"#1c0505",border:"1px solid #7f1d1d",borderRadius:10,padding:"14px 18px",color:"#f87171",fontSize:13,marginBottom:16}}>{error}</div>}

      {summary&&!loading&&(
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:16}}>
          {[
            {label:"SECTOR",value:summary.sector,color:"#60a5fa"},
            {label:"TIMEFRAME",value:summary.tf,color:"#94a3b8"},
            {label:"STOCKS FOUND",value:summary.total,color:"#f1f5f9"},
            {label:"OVERREACTIONS",value:summary.over+"/"+summary.total,color:"#4ade80"},
            {label:"HIGH PROB RECOVERY",value:summary.highProb,color:"#22c55e"},
          ].map(function(m,i){return(
            <div key={i} style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:8,padding:"10px 14px"}}>
              <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:4}}>{m.label}</div>
              <div style={{fontSize:15,fontWeight:800,color:m.color}}>{m.value}</div>
            </div>
          );})}
        </div>
      )}

      {results.length>0&&!loading&&(
        <div style={{display:"flex",gap:6,marginBottom:14}}>
          {["all","buy","watch","avoid"].map(function(f){return(
            <button key={f} onClick={function(){setFilter(f);}}
              style={{background:filter===f?"#1e293b":"transparent",border:"1px solid "+(filter===f?"#334155":"#0f172a"),borderRadius:6,padding:"5px 12px",fontSize:11,fontWeight:600,color:filter===f?"#f1f5f9":"#334155",cursor:"pointer",textTransform:"capitalize"}}>{f}</button>
          );})}
        </div>
      )}

      {shown.map(function(l,i){
        var vs=VS2[l.verdict]||VS2["Mixed"];
        var rc2=l.recommendation==="Strong Buy"?"#22c55e":l.recommendation==="Buy"?"#4ade80":l.recommendation==="Watch"?"#f59e0b":"#f87171";
        return(
          <div key={l.ticker+i} style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:14,padding:"20px 22px",marginBottom:12,animation:"fu 0.3s ease "+(i*0.05)+"s both"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
              <div style={{display:"flex",gap:14,alignItems:"center"}}>
                <div><div style={{fontSize:22,fontWeight:800,color:"#f1f5f9"}}>{l.ticker}</div><div style={{fontSize:11,color:"#475569",marginTop:2}}>{l.name}</div></div>
                <div><div style={{fontSize:18,fontWeight:800,color:"#ef4444"}}>{l.selectedTfChange}</div><div style={{fontSize:10,color:"#475569",marginTop:2}}>over {tfCurrent.label}</div></div>
                <div><div style={{fontSize:15,fontWeight:600,color:"#94a3b8"}}>{l.price}</div><div style={{fontSize:10,color:"#334155",marginTop:2}}>{l.marketCap}</div></div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:800,background:vs.bg,color:vs.c,border:"1px solid "+vs.b,display:"flex",alignItems:"center",gap:6}}><span style={{width:7,height:7,borderRadius:"50%",background:vs.dot,display:"inline-block"}}/>{l.verdict}</span>
                <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:700,background:"#0f172a",border:"1px solid #1e293b",color:rc2}}>{l.recommendation}</span>
                {l.dataScore!=null&&(
                  <span style={{padding:"5px 10px",borderRadius:6,fontSize:10,fontWeight:800,background:"#0c1a2e",color:l.dataScore>=70?"#4ade80":l.dataScore>=45?"#f59e0b":"#f87171",border:"1px solid "+(l.dataScore>=70?"#1d4ed8":l.dataScore>=45?"#d97706":"#7f1d1d")}}>
                    {l.dataScore}/100
                  </span>
                )}
                {(function(){var ss=screenerSig(l.ticker);if(!ss||ss==="HOLD")return null;var sc=ss==="STRONG_BUY"?"#22c55e":ss==="BUY"?"#4ade80":ss==="WATCH"?"#f59e0b":"#f87171";return <span style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontWeight:700,background:"#0f172a",border:"1px solid "+sc,color:sc,letterSpacing:1}}>{"SCREENER: "+ss.replace("_"," ")}</span>;}())}
              </div>
            </div>
            {l.performance&&<div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
              {Object.entries(l.performance).filter(function(e){return e[1]!==null;}).map(function(e,i){
                var active=e[0]===timeframe,neg=e[1]<0;
                return(<div key={i} style={{background:active?(neg?"#2d0a0a":"#0a2d12"):(neg?"#1c0505":"#052e16"),border:"1px solid "+(active?(neg?"#ef4444":"#22c55e"):(neg?"#7f1d1d":"#14532d")),borderRadius:6,padding:"5px 9px",textAlign:"center",opacity:active?1:0.65}}>
                  <div style={{fontSize:8,color:"#64748b",marginBottom:2}}>{e[0]}{active?" *":""}</div>
                  <div style={{fontSize:12,fontWeight:700,color:neg?"#f87171":"#4ade80"}}>{e[1]>0?"+":""}{e[1]}%</div>
                </div>);
              })}
            </div>}
            <div style={{background:"#030712",border:"1px solid #0f172a",borderRadius:8,padding:"10px 14px",marginBottom:10}}>
              <span style={{fontSize:9,color:"#334155",letterSpacing:2,marginRight:10}}>CATALYST</span>
              <span style={{fontSize:12,color:"#94a3b8"}}>{l.catalyst}</span>
            </div>
            {l.multiTfAnalysis&&<div style={{background:"#030712",border:"1px solid "+vs.b,borderRadius:8,padding:"10px 14px",marginBottom:10}}>
              <span style={{fontSize:9,color:vs.c,letterSpacing:2,marginRight:10,fontWeight:700}}>PATTERN</span>
              <span style={{fontSize:12,color:"#94a3b8"}}>{l.multiTfAnalysis}</span>
            </div>}
            <div style={{display:"flex",gap:12,marginBottom:12,flexWrap:"wrap"}}>
              <div style={{background:"#030712",border:"1px solid #1e293b",borderRadius:8,padding:"8px 12px",flex:1}}><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:3}}>RECOVERY PROB</div><div style={{fontSize:13,fontWeight:700,color:l.recoveryProbability==="High"?"#4ade80":l.recoveryProbability==="Medium"?"#f59e0b":"#f87171"}}>{l.recoveryProbability||"?"}</div></div>
              <div style={{background:"#030712",border:"1px solid #1e293b",borderRadius:8,padding:"8px 12px",flex:1}}><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:3}}>EST. TIMELINE</div><div style={{fontSize:13,fontWeight:700,color:"#94a3b8"}}>{l.recoveryTimeline||"Unclear"}</div></div>
              <div style={{background:"#030712",border:"1px solid #1e293b",borderRadius:8,padding:"8px 12px",flex:1}}><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:3}}>ANALYST TARGET</div><div style={{fontSize:13,fontWeight:700,color:"#f1f5f9"}}>{l.analystTarget||"N/A"}</div></div>
              <div style={{background:"#030712",border:"1px solid #1e293b",borderRadius:8,padding:"8px 12px",flex:1}}><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:3}}>UPSIDE</div><div style={{fontSize:13,fontWeight:700,color:parseFloat(l.upsideNum||0)>0?"#4ade80":"#f87171"}}>{l.upside||"N/A"}</div></div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
              <div style={{background:"#030e05",border:"1px solid #14532d",borderRadius:8,padding:"12px 14px"}}><div style={{fontSize:9,color:"#16a34a",letterSpacing:2,fontWeight:700,marginBottom:7}}>BULL CASE</div><div style={{fontSize:12,color:"#86efac",lineHeight:1.6}}>{l.bull}</div></div>
              <div style={{background:"#0e0303",border:"1px solid #7f1d1d",borderRadius:8,padding:"12px 14px"}}><div style={{fontSize:9,color:"#b91c1c",letterSpacing:2,fontWeight:700,marginBottom:7}}>BEAR CASE</div><div style={{fontSize:12,color:"#fca5a5",lineHeight:1.6}}>{l.bear}</div></div>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
              <div style={{display:"flex",gap:8}}>
                {watchlist.find(function(w){return w.ticker===l.ticker;})?
                  <button onClick={function(){removeFromWatchlist(l.ticker);}} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>In Watchlist</button>:
                  <button onClick={function(){addToWatchlist(l.ticker,l.name);}} style={{background:"transparent",border:"1px solid #1d4ed8",color:"#60a5fa",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>+ Add to Screener</button>
                }
                <button onClick={function(){toggleExpand(l.ticker,"chart");}} style={{background:expanded[l.ticker]&&expanded[l.ticker].chart?"#0c1a2e":"transparent",border:"1px solid #1e293b",color:expanded[l.ticker]&&expanded[l.ticker].chart?"#60a5fa":"#475569",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>Chart</button>
                <button onClick={function(){toggleExpand(l.ticker,"ratings");}} style={{background:expanded[l.ticker]&&expanded[l.ticker].ratings?"#0c1a2e":"transparent",border:"1px solid #1e293b",color:expanded[l.ticker]&&expanded[l.ticker].ratings?"#60a5fa":"#475569",borderRadius:8,padding:"8px 14px",fontSize:12,cursor:"pointer"}}>Analysts</button>
              </div>
              {(l.recommendation==="Strong Buy"||l.recommendation==="Buy")&&<button onClick={function(){var m=props.stocks.find(function(s){return s.ticker===l.ticker;});props.setModal(m?Object.assign({},m,{side:"BUY"}):{ticker:l.ticker,cur:parseFloat((l.price||"0").replace(/[^0-9.]/g,"")),sl:0,tp:0,side:"BUY"});props.setTab("paper");props.setQty(1);}} style={{background:"#15803d",border:"none",color:"#fff",borderRadius:8,padding:"10px 20px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Paper Buy {l.ticker}</button>}
              <button onClick={function(){setDeepDiveStock(l);runDeepDive(l,setDeepDiveResult,setDeepDiveLoading);}} style={{background:"linear-gradient(135deg,#7c3aed,#1d4ed8)",border:"none",color:"#fff",borderRadius:8,padding:"10px 20px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Deep Dive</button>
            </div>
            {expanded[l.ticker]&&expanded[l.ticker].chart&&(<div style={{marginTop:12,borderTop:"1px solid #0f172a",paddingTop:12}}><PriceChart data={chartData[l.ticker]} ticker={l.ticker}/></div>)}
            {expanded[l.ticker]&&expanded[l.ticker].ratings&&(<div style={{marginTop:12,borderTop:"1px solid #0f172a",paddingTop:12}}><AnalystChart data={ratingsData[l.ticker]}/></div>)}
          </div>
        );
      })}

      {/* Deep Dive Modal */}
      {deepDiveStock&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={function(e){if(e.target===e.currentTarget){setDeepDiveStock(null);setDeepDiveResult(null);}}}>
          <div style={{background:"#0a0f1a",border:"1px solid #7c3aed",borderRadius:16,width:"100%",maxWidth:560,maxHeight:"85vh",overflowY:"auto",padding:"24px 26px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
              <div><div style={{fontSize:22,fontWeight:800,color:"#f1f5f9"}}>{deepDiveStock.ticker} Deep Dive</div><div style={{fontSize:11,color:"#475569",marginTop:3}}>Second-opinion with self-verification</div></div>
              <button onClick={function(){setDeepDiveStock(null);setDeepDiveResult(null);}} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:6,padding:"6px 12px",cursor:"pointer",fontSize:16}}>x</button>
            </div>
            {deepDiveLoading&&(<div style={{display:"flex",gap:12,padding:"30px 0",justifyContent:"center"}}><div style={{fontSize:13,color:"#94a3b8"}}>Performing deep analysis...</div></div>)}
            {deepDiveResult&&!deepDiveLoading&&(function(){
              var r=deepDiveResult;
              if(r.error) return(<div style={{color:"#f87171",padding:20}}>{r.error}</div>);
              var rcc=r.recommendation==="Strong Buy"||r.recommendation==="Buy"?"#4ade80":r.recommendation==="Watch"?"#f59e0b":"#f87171";
              return(<div>
                {r.verdictChanged&&(<div style={{background:"#1c0505",border:"1px solid #7f1d1d",borderRadius:8,padding:"10px 14px",marginBottom:14}}><span style={{fontSize:12,color:"#fca5a5",fontWeight:600}}>Verdict revised: {r.changeReason}</span></div>)}
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
                  <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:800,background:"#0f172a",border:"1px solid #334155",color:"#f1f5f9"}}>{r.verdict}</span>
                  <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:700,background:"#0f172a",border:"1px solid #1e293b",color:rcc}}>{r.recommendation}</span>
                </div>
                {r.priceTargetAnalysis&&(<div style={{background:"#030712",border:"1px solid #1e293b",borderRadius:8,padding:"12px 14px",marginBottom:10}}><div style={{fontSize:9,color:"#475569",letterSpacing:2,marginBottom:5}}>PRICE TARGET ANALYSIS</div><div style={{fontSize:12,color:"#94a3b8",lineHeight:1.7}}>{r.priceTargetAnalysis}</div></div>)}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
                  <div style={{background:"#030e05",border:"1px solid #14532d",borderRadius:8,padding:"12px 14px"}}><div style={{fontSize:9,color:"#16a34a",letterSpacing:2,marginBottom:8}}>OPPORTUNITIES</div>{(r.keyOpportunities||[]).map(function(o,i){return(<div key={i} style={{fontSize:11,color:"#86efac",marginBottom:4}}>{"- "+o}</div>);})}</div>
                  <div style={{background:"#0e0303",border:"1px solid #7f1d1d",borderRadius:8,padding:"12px 14px"}}><div style={{fontSize:9,color:"#b91c1c",letterSpacing:2,marginBottom:8}}>RISKS</div>{(r.keyRisks||[]).map(function(k,i){return(<div key={i} style={{fontSize:11,color:"#fca5a5",marginBottom:4}}>{"- "+k}</div>);})}</div>
                </div>
                {r.finalCall&&(<div style={{background:"#030712",border:"1px solid #7c3aed",borderRadius:8,padding:"12px 14px",marginBottom:12}}><div style={{fontSize:9,color:"#a78bfa",letterSpacing:2,marginBottom:6}}>FINAL CALL</div><div style={{fontSize:13,color:"#e2e8f0",lineHeight:1.7}}>{r.finalCall}</div></div>)}
              </div>);
            })()}
          </div>
        </div>
      )}

      {results.length>0&&!loading&&<div style={{marginTop:14,padding:"10px 14px",background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:8,fontSize:10,color:"#334155"}}>AI analysis is for educational purposes only. Not financial advice. Real market data from FMP + Finnhub.</div>}
    </div>
  );
}


import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from"recharts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getTimeET(ts) {
 return new Date(ts).toLocaleTimeString("en-US", {
 timeZone:"America/New_York", hour:"2-digit", minute:"2-digit", hour12: false,
 });
}

function getTradingDays(start, end) {
 const days = [];
 const cur = new Date(start +"T12:00:00Z");
 const fin = new Date(end +"T12:00:00Z");
 while (cur <= fin) {
 const dow = cur.getUTCDay();
 if (dow !== 0 && dow !== 6) days.push(cur.toISOString().split("T")[0]);
 cur.setUTCDate(cur.getUTCDate() + 1);
 }
 return days;
}

function fmt(n, dec = 2) {
 return n !== undefined ? (n >= 0 ?"+":"") + n.toFixed(dec) :"";
}

function daysAgo(n) {
 const d = new Date();
 d.setDate(d.getDate() - n);
 return d.toISOString().split("T")[0];
}

function minsFromMidnight(ts) {
 const t = getTimeET(ts);
 const [h, m] = t.split(":").map(Number);
 return h * 60 + m;
}

const filterPremarket = (bars) =>
 bars.filter((b) => { const m = minsFromMidnight(b.t); return m >= 240 && m < 570; });
const get931Bar = (bars) => bars.find((b) => getTimeET(b.t) ==="09:31");
const getIntraday = (bars) =>
 bars.filter((b) => { const m = minsFromMidnight(b.t); return m >= 571 && m <= 960; });
const getRegular = (bars) =>
 bars.filter((b) => { const m = minsFromMidnight(b.t); return m >= 570 && m <= 960; });

// Polygon API 

async function polyBars(ticker, date, key) {
 const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=1000&apiKey=${key}`);
 if (!res.ok) throw new Error(`Polygon bars ${res.status}`);
 const d = await res.json();
 if (d.status ==="ERROR") throw new Error(d.error ||"Polygon error");
 return d.results || [];
}

async function polyBarsRange(ticker, from, to, key) {
 const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`);
 if (!res.ok) throw new Error(`Polygon ${res.status}`);
 const d = await res.json();
 return Array.isArray(d.results) ? d.results : [];
}
function groupBarsByDate(bars) {
 const out = {};
 for (const b of bars) {
  const dt = new Date(b.t - 18000000);
  const k = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth()+1).padStart(2,'0') + '-' + String(dt.getUTCDate()).padStart(2,'0');
  if (!out[k]) out[k] = [];
  out[k].push(b);
 }
 return out;
}
async function polyPrevClose(ticker, key) {
 const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${key}`);
 if (!res.ok) throw new Error(`Polygon prev ${res.status}`);
 const d = await res.json();
 return d.results?.[0]?.c || null;
}

async function polyAvgVolume(ticker, key) {
 const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${daysAgo(31)}/${daysAgo(1)}?adjusted=true&sort=asc&limit=35&apiKey=${key}`);
 if (!res.ok) return null;
 const d = await res.json();
 const results = d.results || [];
 if (!results.length) return null;
 return results.reduce((s, b) => s + b.v, 0) / results.length;
}

// Alpaca API Primary live scanner source (free) 
// Free paper account at alpaca.markets covers 4am8pm extended hours

function alpacaHeaders(id, secret) {
 return {"APCA-API-KEY-ID": id,"APCA-API-SECRET-KEY": secret };
}

function toAlpacaET(date, hour, min = 0) {
 return`${date}T${String(hour).padStart(2,"0")}:${String(min).padStart(2,"0")}:00-04:00`;
}

async function alpacaBars(ticker, date, id, secret) {
 const start = encodeURIComponent(toAlpacaET(date, 4));
 const end = encodeURIComponent(toAlpacaET(date, 20));
 const url =`https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Min&start=${start}&end=${end}&limit=1000&feed=iex&sort=asc`;
 const res = await fetch(url, { headers: alpacaHeaders(id, secret) });
 if (!res.ok) throw new Error(`Alpaca bars ${res.status}`);
 const d = await res.json();
 return (d.bars || []).map((b) => ({ t: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

async function alpacaPrevClose(ticker, id, secret) {
 const url =`https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&limit=2&feed=iex&sort=desc`;
 const res = await fetch(url, { headers: alpacaHeaders(id, secret) });
 if (!res.ok) return null;
 const d = await res.json();
 const bars = d.bars || [];
 return bars.length >= 2 ? bars[1].c : bars[0]?.c ?? null;
}

async function alpacaAvgVolume(ticker, id, secret) {
 const url =`https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&limit=30&feed=iex&sort=desc`;
 const res = await fetch(url, { headers: alpacaHeaders(id, secret) });
 if (!res.ok) return null;
 const d = await res.json();
 const bars = d.bars || [];
 if (!bars.length) return null;
 return bars.reduce((s, b) => s + b.v, 0) / bars.length;
}

async function alpacaSpyContext(id, secret) {
 const today = new Date().toISOString().split("T")[0];
 try {
 const bars = await alpacaBars("SPY", today, id, secret);
 const pm = filterPremarket(bars);
 if (!pm.length) return { spyScore: 5, spyGap: 0 };
 const spyGap = ((pm.at(-1).c - pm[0].o) / pm[0].o) * 100;
 return { spyScore: spyGap > 0.3 ? 10 : spyGap > -0.1 ? 5 : 0, spyGap: parseFloat(spyGap.toFixed(2)) };
 } catch {
 return { spyScore: 5, spyGap: 0 };
 }
}

// FMP Catalyst (Primary real earnings beats + analyst ratings) 
async function fmpEarnings(ticker, date, fmpKey) {
 const from = new Date(date);
 from.setDate(from.getDate() - 3);
 const fromStr = from.toISOString().split("T")[0];
 const res = await fetch(`https://financialmodelingprep.com/stable/earnings?symbol=${ticker}&from=${fromStr}&to=${date}&apikey=${fmpKey}`);
 if (!res.ok) return null;
 const data = await res.json();
 const results = Array.isArray(data) ? data : (data.earningsCalendar || []);
 if (!results.length) return null;
 const report = results[0];
 const actual = report.epsActual ?? report.eps;
 const est = report.epsEstimated ?? report.estimatedEps;
 if (actual == null || est == null || est === 0) return null;
 const beatPct = ((actual - est) / Math.abs(est)) * 100;
 return { beatPct: parseFloat(beatPct.toFixed(1)), actual, est, date: report.date };
}

async function fmpAnalyst(ticker, date, fmpKey) {
 const from = new Date(date);
 from.setDate(from.getDate() - 2);
 const fromStr = from.toISOString().split("T")[0];
 const res = await fetch(`https://financialmodelingprep.com/stable/upgrades-downgrades?symbol=${ticker}&from=${fromStr}&to=${date}&apikey=${fmpKey}`);
 if (!res.ok) return [];
 const data = await res.json();
 return Array.isArray(data) ? data : [];
}

async function fmpNews(ticker, date, fmpKey) {
 const from = new Date(date);
 from.setDate(from.getDate() - 1);
 const fromStr = from.toISOString().split("T")[0];
 const res = await fetch(`https://financialmodelingprep.com/stable/news/stock?symbols=${ticker}&from=${fromStr}&to=${date}&limit=5&apikey=${fmpKey}`);
 if (!res.ok) return [];
 const data = await res.json();
 return Array.isArray(data) ? data : [];
}

async function getCatalyst(ticker, date, polygonKey, fmpKey) {
 if (fmpKey) {
 try {
 const [earnings, analysts, news] = await Promise.all([
 fmpEarnings(ticker, date, fmpKey).catch(() => null),
 fmpAnalyst(ticker, date, fmpKey).catch(() => []),
 fmpNews(ticker, date, fmpKey).catch(() => []),
 ]);
 let catalystScore = 0;
 const headlines = [];
 let catalystType ="none";
 if (earnings) {
 const { beatPct, actual, est } = earnings;
 if (beatPct >= 10) { catalystScore = 25; catalystType ="earnings-beat"; }
 else if (beatPct >= 5) { catalystScore = 20; catalystType ="earnings-beat"; }
 else if (beatPct >= 1) { catalystScore = 15; catalystType ="earnings-beat"; }
 else if (beatPct >= -2) { catalystScore = 8; catalystType ="earnings-inline"; }
 else { catalystScore = 0; catalystType ="earnings-miss"; }
 const tag = beatPct >= 0 ?`Beat by ${beatPct.toFixed(1)}%`:`Missed by ${Math.abs(beatPct).toFixed(1)}%`;
 headlines.push(`Earnings ${tag} (actual: $${actual?.toFixed(2)} vs est: $${est?.toFixed(2)})`);
 }
 for (const a of analysts) {
 const action = (a.action || a.newGrade ||"").toLowerCase();
 const isUp = action.includes("upgrade") || action.includes("buy") || action.includes("overweight") || action.includes("outperform");
 const isDown = action.includes("downgrade") || action.includes("sell") || action.includes("underperform");
 if (isUp) { catalystScore = Math.max(catalystScore, 18); catalystType = catalystType ==="none"?"upgrade": catalystType; }
 if (isDown) { catalystScore = Math.max(catalystScore, 0); catalystType = catalystType ==="none"?"downgrade": catalystType; }
 headlines.push(`${a.gradingCompany ||"Analyst"}: ${a.newGrade || a.action || action}`);
 }
 if (catalystScore === 0 && news.length) {
 const HIGH = ["fda","approved","approval","merger","acqui","deal","buyout"];
 const MED = ["partnership","contract","launch","guidance"];
 for (const item of news) {
 const t = (item.title || item.text ||"").toLowerCase();
 if (HIGH.some((kw) => t.includes(kw))) { catalystScore = Math.max(catalystScore, 20); catalystType ="fda-ma"; }
 else if (MED.some((kw) => t.includes(kw))) { catalystScore = Math.max(catalystScore, 10); catalystType ="news"; }
 else catalystScore = Math.max(catalystScore, 3);
 headlines.push(item.title || item.text ||"");
 }
 }
 return { catalystScore, headlines: headlines.slice(0, 3), catalystType, source:"FMP"};
 } catch { /* Fall through */ }
 }
 if (polygonKey) {
 try {
 const from = new Date(date); from.setDate(from.getDate() - 1);
 const fromStr = from.toISOString().split("T")[0];
 const res = await fetch(`https://api.polygon.io/v2/reference/news?ticker=${ticker}&published_utc.gte=${fromStr}T18:00:00Z&published_utc.lte=${date}T13:30:00Z&limit=5&apiKey=${polygonKey}`);
 if (!res.ok) return { catalystScore: 0, headlines: [], catalystType:"none", source:"none"};
 const d = await res.json();
 const results = d.results || [];
 if (!results.length) return { catalystScore: 0, headlines: [], catalystType:"none", source:"none"};
 const HIGH = ["earnings","beat","revenue","fda","approved","merger","acqui","upgrade","raised"];
 const MED = ["guidance","analyst","launch","partnership","contract","quarterly","results"];
 let catalystScore = 0; const headlines = [];
 for (const item of results) {
 const title = (item.title ||"").toLowerCase();
 if (HIGH.some((kw) => title.includes(kw))) catalystScore = Math.max(catalystScore, 20);
 else if (MED.some((kw) => title.includes(kw))) catalystScore = Math.max(catalystScore, 10);
 else catalystScore = Math.max(catalystScore, 3);
 headlines.push(item.title);
 }
 return { catalystScore, headlines, catalystType:"news-keyword", source:"Polygon"};
 } catch { /* silent */ }
 }
 return { catalystScore: 0, headlines: [], catalystType:"none", source:"none"};
}

async function spyContext(date, key) {
 try {
 const bars = await polyBars("SPY", date, key);
 const pm = filterPremarket(bars);
 if (!pm.length) return { spyScore: 5, spyGap: 0 };
 const spyGap = ((pm.at(-1).c - pm[0].o) / pm[0].o) * 100;
 return { spyScore: spyGap > 0.3 ? 10 : spyGap > -0.1 ? 5 : 0, spyGap: parseFloat(spyGap.toFixed(2)) };
 } catch { return { spyScore: 5, spyGap: 0 }; }
}

function scoreSignals({ pmBars, prevClose, avgDailyVol, catalystData, spyData, shortInterestPct }) {
 const bd = { gap: 0, momentum: 0, consistency: 0, catalyst: 0, relVol: 0, marketCtx: 0, shortInt: 0 };
 if (!pmBars.length || !prevClose) return { score: 0, gap: 0, pmVol: 0, breakdown: bd };
 const lastC = pmBars.at(-1).c;
 const gap = ((lastC - prevClose) / prevClose) * 100;
 const pmVol = pmBars.reduce((s, b) => s + b.v, 0);
 bd.gap = parseFloat(Math.min(gap < 0.5 ? 0 : (gap / 6) * 20, 20).toFixed(1));
 const last30 = pmBars.slice(-30);
 const mom = last30.length > 1 ? ((last30.at(-1).c - last30[0].o) / last30[0].o) * 100 : 0;
 bd.momentum = parseFloat(Math.min(Math.max((mom / 2) * 10, 0), 10).toFixed(1));
 bd.consistency = parseFloat((pmBars.filter((b) => b.c >= b.o).length / pmBars.length * 5).toFixed(1));
 bd.catalyst = catalystData?.catalystScore ?? 0;
 if (avgDailyVol && avgDailyVol > 0) {
 const rvol = (pmVol * 1.18) / (avgDailyVol * 0.05);
 bd.relVol = parseFloat(Math.min(rvol * 6.5, 20).toFixed(1));
 } else { bd.relVol = 5; }
 bd.marketCtx = spyData?.spyScore ?? 5;
 bd.shortInt = shortInterestPct != null ? parseFloat(Math.min((shortInterestPct / 30) * 5, 5).toFixed(1)) : 2.5;
 const score = Math.min(Math.round(Object.values(bd).reduce((a, b) => a + b, 0)), 100);
 const rvol = avgDailyVol ? parseFloat((pmVol * 1.18 / (avgDailyVol * 0.05)).toFixed(2)) : null;
 return { score, gap: parseFloat(gap.toFixed(2)), pmVol, breakdown: bd, rvol, spyGap: spyData?.spyGap ?? 0, headlines: catalystData?.headlines || [] };
}

function evaluateTrade(intradayBars, entryPrice, winPct, lossPct) {
 const win = entryPrice * (1 + winPct / 100);
 const stop = entryPrice * (1 - lossPct / 100);
 for (const bar of intradayBars) {
 if (bar.h >= win) return { result:"WIN", pct: winPct };
 if (bar.l <= stop) return { result:"LOSS", pct: -lossPct };
 }
 const last = intradayBars.at(-1);
 if (!last) return { result:"TIMEOUT", pct: 0 };
 return { result:"TIMEOUT", pct: parseFloat((((last.c - entryPrice) / entryPrice) * 100).toFixed(2)) };
}

function calcStats(trades) {
 if (!trades.length) return {};
 const wins = trades.filter((t) => t.result ==="WIN");
 const losses = trades.filter((t) => t.result ==="LOSS");
 const to = trades.filter((t) => t.result ==="TIMEOUT");
 const avgW = wins.length ? wins.reduce((s, t) => s + t.pct, 0) / wins.length : 0;
 const avgL = losses.length ? losses.reduce((s, t) => s + t.pct, 0) / losses.length : 0;
 const pf = losses.length && avgL !== 0 ? Math.abs((wins.length * avgW) / (losses.length * avgL)).toFixed(2) :"";
 return {
 winRate: ((wins.length / trades.length) * 100).toFixed(1),
 wins: wins.length, losses: losses.length, timeouts: to.length, total: trades.length,
 avgWin: avgW.toFixed(2), avgLoss: avgL.toFixed(2), pf,
 totalPct: trades.reduce((s, t) => s + t.pct, 0).toFixed(2),
 };
}

function demoSig(seed) {
 const r = (min, max, s) => min + ((s * 9301 + 49297) % 233280) / 233280 * (max - min);
 const gap = parseFloat(r(0.3, 6.5, seed).toFixed(2));
 const cat = [0, 0, 5, 12, 25][Math.floor(r(0, 5, seed * 7))];
 const rvol = parseFloat(r(0.4, 4.8, seed * 13).toFixed(2));
 const si = parseFloat(r(3, 38, seed * 17).toFixed(1));
 const spyG = r(-0.4, 0.8, seed * 3);
 const bd = {
 gap: parseFloat(Math.min(gap < 0.5 ? 0 : (gap / 6) * 20, 20).toFixed(1)),
 momentum: parseFloat(r(0, 10, seed * 11).toFixed(1)),
 consistency: parseFloat(r(2, 5, seed * 19).toFixed(1)),
 catalyst: cat,
 relVol: parseFloat(Math.min(rvol * 6.5, 20).toFixed(1)),
 marketCtx: spyG > 0.3 ? 10 : spyG > -0.1 ? 5 : 0,
 shortInt: parseFloat(Math.min((si / 30) * 5, 5).toFixed(1)),
 };
 const score = Math.min(Math.round(Object.values(bd).reduce((a, b) => a + b, 0)), 100);
 const headlines = cat >= 25 ? ["Q4 earnings beat estimates by 12%, revenue guidance raised"]
 : cat >= 12 ? ["Analyst upgrade to Overweight, price target raised"]
 : cat >= 5 ? ["Company announces new strategic partnership"] : [];
 return { score, gap, rvol, spyGap: parseFloat(spyG.toFixed(2)), breakdown: bd, headlines };
}

function genDemo(ticker, start, end, winPct, lossPct) {
 const days = getTradingDays(start, end);
 const trades = []; let equity = 10000;
 const curve = [{ date:"Start", equity, cumPct: 0 }];
 days.forEach((date, i) => {
 const seed = i * 997 + date.charCodeAt(5) * 31;
 const sig = demoSig(seed);
 if (sig.score < 40) return;
 const entryPrice = parseFloat((80 + (seed % 320)).toFixed(2));
 const pmVol = Math.round(40000 + (seed * 13337) % 760000);
 const roll = ((seed * 2654435769) >>> 0) / 0xFFFFFFFF;
 let result, pct;
 if (roll < 0.57) { result ="WIN"; pct = winPct; }
 else if (roll < 0.87) { result ="LOSS"; pct = -lossPct; }
 else { result ="TIMEOUT"; pct = parseFloat((-0.3 + (seed % 1000) / 555).toFixed(2)); }
 equity *= 1 + pct / 100;
 const cumPct = parseFloat((((equity - 10000) / 10000) * 100).toFixed(2));
 trades.push({ date, ticker, entryPrice, pmVol, result, pct, ...sig });
 curve.push({ date, equity: Math.round(equity), cumPct });
 });
 return { trades, curve, stats: calcStats(trades) };
}

const T = {
 bg:"#06090f", surface:"#0b1220", panel:"#0f1928", border:"#172236",
 text:"#c8ddf5", muted:"#3d5a7a", dim:"#1e3050",
 green:"#00cc6a", red:"#ff3d4a", amber:"#f5a520", blue:"#2d8fff", purple:"#9b6dff",
};
const S = {
 input: { background: T.surface, border:`1px solid ${T.border}`, color: T.text, padding:"8px 12px", borderRadius:"6px", fontFamily:"inherit", fontSize:"13px", outline:"none", width:"100%", boxSizing:"border-box"},
 btn: { background: T.blue, color:"#fff", border:"none", padding:"9px 20px", borderRadius:"6px", cursor:"pointer", fontFamily:"inherit", fontSize:"13px", fontWeight: 700, letterSpacing:"0.05em"},
 card: { background: T.panel, border:`1px solid ${T.border}`, borderRadius:"8px", padding:"16px"},
 label: { display:"block", color: T.muted, fontSize:"11px", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"6px"},
};

function Badge({ result }) {
 const map = { WIN: { bg:"#00331a", color: T.green, label:"WIN"}, LOSS: { bg:"#330a0d", color: T.red, label:"LOSS"}, TIMEOUT: { bg:"#1a1530", color: T.purple, label:"TIME"}, STRONG: { bg:"#00331a", color: T.green, label:"STRONG"}, MODERATE: { bg:"#2a1f00", color: T.amber, label:"MOD"}, WEAK: { bg:"#1a1020", color: T.muted, label:"WEAK"}, ERROR: { bg:"#330a0d", color: T.red, label:"ERR"} };
 const s = map[result] || map.WEAK;
 return <span style={{ background: s.bg, color: s.color, border:`1px solid ${s.color}33`, padding:"2px 8px", borderRadius:"4px", fontSize:"10px", fontWeight: 700, letterSpacing:"0.1em"}}>{s.label}</span>;
}

function StatCard({ label, value, sub, color }) {
 return (
 <div style={{ ...S.card, textAlign:"center", minWidth: 110 }}>
 <div style={{ fontSize:"11px", color: T.muted, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"8px"}}>{label}</div>
 <div style={{ fontSize:"22px", fontWeight: 700, color: color || T.text, lineHeight: 1 }}>{value}</div>
 {sub && <div style={{ fontSize:"11px", color: T.muted, marginTop:"4px"}}>{sub}</div>}
 </div>
 );
}

function ScoreBar({ score, max = 100, color }) {
 const c = color || (score / max >= 0.7 ? T.green : score / max >= 0.5 ? T.amber : T.muted);
 return (
 <div style={{ display:"flex", alignItems:"center", gap:"8px"}}>
 <div style={{ flex: 1, height:"4px", background: T.dim, borderRadius:"2px"}}>
 <div style={{ width:`${Math.round((score / max) * 100)}%`, height:"100%", background: c, borderRadius:"2px", transition:"width 0.5s ease"}} />
 </div>
 <span style={{ color: c, fontSize:"11px", minWidth: 28, textAlign:"right"}}>{score}{max !== 100 ?`/${max}`:""}</span>
 </div>
 );
}

function ScoreBreakdown({ breakdown, headlines, rvol, spyGap, catalystSource }) {
 const signals = [
 { key:"catalyst", label:"Catalyst", max: 25, icon:""},
 { key:"relVol", label:"Relative Volume", max: 20, icon:""},
 { key:"gap", label:"Gap %", max: 20, icon:""},
 { key:"momentum", label:"PM Momentum", max: 10, icon:""},
 { key:"marketCtx", label:"Market Context", max: 10, icon:""},
 { key:"consistency", label:"PM Consistency", max: 5, icon:""},
 { key:"shortInt", label:"Short Interest", max: 5, icon:""},
 ];
 return (
 <div style={{ background: T.bg, border:`1px solid ${T.border}`, borderRadius:"8px", padding:"14px", marginTop: 8 }}>
 <div style={{ fontSize:"10px", color: T.muted, letterSpacing:"0.1em", marginBottom: 10 }}>SIGNAL BREAKDOWN</div>
 <div style={{ display:"flex", flexDirection:"column", gap: 8 }}>
 {signals.map(({ key, label, max, icon }) => (
 <div key={key} style={{ display:"grid", gridTemplateColumns:"18px 140px 1fr 42px", alignItems:"center", gap: 8 }}>
 <span style={{ fontSize:"11px"}}>{icon}</span>
 <span style={{ fontSize:"11px", color: T.muted }}>{label}</span>
 <ScoreBar score={breakdown[key] ?? 0} max={max} />
 <span style={{ fontSize:"10px", color: T.muted, textAlign:"right"}}>{breakdown[key] ?? 0}/{max}</span>
 </div>
 ))}
 </div>
 <div style={{ marginTop: 10, fontSize:"11px", color: T.muted, display:"flex", gap: 16 }}>
 {rvol != null && <span>RVOL <span style={{ color: rvol >= 2 ? T.green : T.text }}>{rvol}x</span></span>}
 {spyGap != null && <span>SPY PM <span style={{ color: spyGap >= 0 ? T.green : T.red }}>{spyGap >= 0 ?"+":""}{spyGap}%</span></span>}
 </div>
 {headlines?.length > 0 && (
 <div style={{ marginTop: 10 }}>
 {headlines.slice(0, 3).map((h, i) => (
 <div key={i} style={{ fontSize:"11px", color: T.amber, background:"#1a1200", border:`1px solid ${T.amber}22`, borderRadius: 4, padding:"4px 8px", marginBottom: 4 }}> {h}</div>
 ))}
 </div>
 )}
 {catalystSource && (
 <div style={{ marginTop: 8, fontSize:"10px", color: T.muted }}>
 Catalyst data: <span style={{ color: catalystSource ==="FMP"? T.green : catalystSource ==="Polygon"? T.blue : T.dim }}>
 {catalystSource ==="FMP"?"FMP real earnings & analyst data": catalystSource ==="Polygon"?"Polygon news keyword match":"none"}
 </span>
 </div>
 )}
 </div>
 );
}

function ChartTip({ active, payload, label }) {
 if (!active || !payload?.length) return null;
 const pct = payload[0]?.value;
 return (
 <div style={{ background: T.panel, border:`1px solid ${T.border}`, padding:"8px 12px", borderRadius:"6px", fontSize:"12px"}}>
 <div style={{ color: T.muted, marginBottom: 4 }}>{label}</div>
 <div style={{ color: pct >= 0 ? T.green : T.red, fontWeight: 700 }}>{fmt(pct)}%</div>
 </div>
 );
}

function PreMarketEdge() {
 const [tab, setTab] = useState("backtest");
 const [settings, setSettings] = useState({ polygonKey:"", fmpKey:"", alpacaId:"", alpacaSecret:"", winPct: 2.0, lossPct: 0.5, minScore: 55 });
 // Load saved keys on mount — typeof guard makes this SSR-safe
 useEffect(() => {
  if (typeof window === 'undefined') return;
  try {
   const saved = window.localStorage.getItem('edge_settings');
   if (saved) setSettings(JSON.parse(saved));
  } catch(e) {}
 }, []);
 // Save keys whenever settings change — typeof guard makes this SSR-safe
 useEffect(() => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem('edge_settings', JSON.stringify(settings)); } catch(e) {}
 }, [settings]);

 const [btTicker, setBtTicker] = useState("NVDA");
 const [btStart, setBtStart] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split("T")[0]; });
 const [btEnd, setBtEnd] = useState(() => new Date().toISOString().split("T")[0]);
 const [btRunning, setBtRunning] = useState(false);
 const [btResults, setBtResults] = useState(null);
 const [btProgress, setBtProgress] = useState(0);
 const [btLog, setBtLog] = useState([]);
 const [showLog, setShowLog] = useState(false);
 const [expandRow, setExpandRow] = useState(null);
 const logRef = useRef(null);
 const [scanInput, setScanInput] = useState("");
 const [scanTickers, setScanTickers] = useState(["NVDA","AAPL","TSLA","AMD","META"]);
 const [scanResults, setScanResults] = useState(null);
 const [scanning, setScanning] = useState(false);
 const [expandScan, setExpandScan] = useState(null);

 const addLog = useCallback((msg) => {
 setBtLog((p) => [...p.slice(-200),`${new Date().toLocaleTimeString()} ${msg}`]);
 setTimeout(() => logRef.current?.scrollTo({ top: 99999, behavior:"smooth"}), 50);
 }, []);

 const isDemo = !settings.polygonKey && !settings.alpacaId;
 const isBtLive = !!settings.polygonKey;
 const isScanLive = !!settings.alpacaId && !!settings.alpacaSecret;

 const runBacktest = useCallback(async () => {
 setBtRunning(true); setBtResults(null); setBtProgress(0); setBtLog([]); setExpandRow(null);
 if (!isBtLive) {
 addLog("Demo mode add FREE Polygon key for real backtest");
 for (let i = 0; i <= 100; i += 5) { setBtProgress(i); await sleep(20); }
 const r = genDemo(btTicker, btStart, btEnd, settings.winPct, settings.lossPct);
 addLog(`${r.trades.length} signals | Win ${r.stats.winRate}% | PF ${r.stats.pf} | Total ${fmt(parseFloat(r.stats.totalPct))}%`);
 setBtResults(r); setBtRunning(false); return;
 }
 const days = getTradingDays(btStart, btEnd);
 addLog(`${btTicker} | ${days.length} days | min score ${settings.minScore}`);
 const avgDailyVol = await polyAvgVolume(btTicker, settings.polygonKey).catch(() => null);
 if (avgDailyVol) addLog(`30-day avg vol: ${(avgDailyVol / 1000).toFixed(0)}K`);
 const trades = []; let equity = 10000;
 const curve = [{ date:"Start", equity, cumPct: 0 }];
 let prevClose = null;
 // Bulk fetch: 2 Polygon calls total instead of 3× per day
 addLog('Fetching all bars in bulk...');
 const [allBars, allSpyBars] = await Promise.all([
  polyBarsRange(btTicker, btStart, btEnd, settings.polygonKey),
  polyBarsRange('SPY', btStart, btEnd, settings.polygonKey),
 ]);
 const barsByDate = groupBarsByDate(allBars);
 const spyByDate = groupBarsByDate(allSpyBars);
 addLog(`Got ${allBars.length} bars (${btTicker}) + ${allSpyBars.length} (SPY)`);
 for (let i = 0; i < days.length; i++) {
 const date = days[i];
 setBtProgress(Math.round(((i + 1) / days.length) * 100));
 try {
 const bars = barsByDate[date] || [];
  const rawSpy = spyByDate[date] || [];
  const spyPm = filterPremarket(rawSpy);
  const spyGap = spyPm.length ? ((spyPm.at(-1).c - spyPm[0].o) / spyPm[0].o) * 100 : 0;
  const spy = { spyScore: spyGap > 0.3 ? 10 : spyGap > 0 ? 5 : spyGap < -0.3 ? 0 : 3, spyGap };
  const catData = await getCatalyst(btTicker, date, settings.polygonKey, settings.fmpKey);
  await sleep(120);
 if (!bars.length) { addLog(`${date} no data`); continue; }
 const pmBars = filterPremarket(bars);
 const entry = get931Bar(bars);
 const intra = getIntraday(bars);
 const regular = getRegular(bars);
 // Derive prevClose by scanning back through previous days (handles weekend/holiday gaps)
 if (!prevClose) {
  for (let j = i - 1; j >= 0; j--) {
   const pb = getRegular(barsByDate[days[j]] || []);
   if (pb.length) { prevClose = pb.at(-1).c; break; }
  }
 }
 const savedPrevClose = prevClose;
 if (regular.length) prevClose = regular.at(-1).c; // update for next iteration
 if (!pmBars.length || !entry || !savedPrevClose) { addLog(`${date} no PM data`); continue; }
 const sig = scoreSignals({ pmBars, prevClose: savedPrevClose, avgDailyVol, catalystData: catData, spyData: spy, shortInterestPct: null });
 if (sig.score < settings.minScore) { addLog(`${date} score ${sig.score}`); continue; }
 const trade = evaluateTrade(intra, entry.o, settings.winPct, settings.lossPct);
 equity *= 1 + trade.pct / 100;
 const cumPct = parseFloat((((equity - 10000) / 10000) * 100).toFixed(2));
 trades.push({ date, ticker: btTicker, entryPrice: entry.o, pmVol: sig.pmVol, catalystSource: catData.source, ...sig, ...trade });
 curve.push({ date, equity: Math.round(equity), cumPct });
 const icon = trade.result ==="WIN"?"": trade.result ==="LOSS"?"":"";
 addLog(`${icon} ${date} | ${sig.score}pts | gap +${sig.gap}% rvol ${sig.rvol}x | ${trade.result} (${fmt(trade.pct)}%)`);
 } catch (err) { addLog(`${date} ${err.message}`); }
 }
 setBtProgress(100);
 const stats = calcStats(trades);
 setBtResults({ trades, curve, stats });
 addLog(`${trades.length} signals | Win ${stats.winRate}% | PF ${stats.pf} | Return ${fmt(parseFloat(stats.totalPct))}%`);
 setBtRunning(false);
 }, [btTicker, btStart, btEnd, settings, isBtLive, addLog]);

 const runScan = useCallback(async () => {
 setScanning(true); setScanResults(null); setExpandScan(null);
 if (!isScanLive && !isBtLive) {
 await sleep(700);
 setScanResults(scanTickers.map((ticker, i) => {
 const sig = demoSig(i * 997 + ticker.charCodeAt(0) * 31);
 return { ticker, ...sig, signal: sig.score >= 70 ?"STRONG": sig.score >= 50 ?"MODERATE":"WEAK"};
 }).sort((a, b) => b.score - a.score));
 setScanning(false); return;
 }
 const today = new Date().toISOString().split("T")[0];
 const results = [];
 for (const ticker of scanTickers) {
 try {
 let bars, avgVol, pc, spy;
 if (isScanLive) {
 [bars, avgVol, pc, spy] = await Promise.all([
 alpacaBars(ticker, today, settings.alpacaId, settings.alpacaSecret),
 alpacaAvgVolume(ticker, settings.alpacaId, settings.alpacaSecret),
 alpacaPrevClose(ticker, settings.alpacaId, settings.alpacaSecret),
 alpacaSpyContext(settings.alpacaId, settings.alpacaSecret),
 ]);
 } else {
 [bars, avgVol, pc, spy] = await Promise.all([
 polyBars(ticker, today, settings.polygonKey),
 polyAvgVolume(ticker, settings.polygonKey),
 polyPrevClose(ticker, settings.polygonKey),
 spyContext(today, settings.polygonKey),
 ]);
 }
 const cat = await getCatalyst(ticker, today, settings.polygonKey, settings.fmpKey);
 const sig = scoreSignals({ pmBars: filterPremarket(bars), prevClose: pc, avgDailyVol: avgVol, catalystData: cat, spyData: spy, shortInterestPct: null });
 results.push({ ticker, catalystSource: cat.source, dataSource: isScanLive ?"Alpaca":"Polygon", ...sig, signal: sig.score >= 70 ?"STRONG": sig.score >= 50 ?"MODERATE":"WEAK"});
 await sleep(300);
 } catch (e) {
 results.push({ ticker, score: 0, gap: 0, pmVol: 0, rvol: null, breakdown: {}, headlines: [], signal:"ERROR"});
 }
 }
 setScanResults(results.sort((a, b) => b.score - a.score));
 setScanning(false);
 }, [scanTickers, settings, isScanLive, isBtLive]);

 const TABS = [{ id:"backtest", label:"BACKTEST"}, { id:"scanner", label:"SCANNER"}, { id:"settings", label:"SETTINGS"}];

 return (
 <div style={{ background: T.bg, color: T.text, minHeight:"100vh", fontFamily:"'JetBrains Mono','Courier New',monospace", fontSize:"13px"}}>
 <div style={{ borderBottom:`1px solid ${T.border}`, padding:"14px 24px", display:"flex", alignItems:"center", gap: 16 }}>
 <div>
 <div style={{ fontSize:"15px", fontWeight: 700, letterSpacing:"0.12em", color: T.blue }}> PRE-MARKET EDGE</div>
 <div style={{ fontSize:"10px", color: T.muted, letterSpacing:"0.08em"}}>7-SIGNAL SCORER BACKTEST 9:31 MARKET ENTRY</div>
 </div>
 <div style={{ marginLeft:"auto", display:"flex", gap: 8, alignItems:"center"}}>
 <div style={{ fontSize:"11px", color: T.muted }}>WIN +{settings.winPct}% STOP -{settings.lossPct}%</div>
 <span style={{ background: isBtLive ?"#00330f":"#2a1e00", border:`1px solid ${isBtLive ? T.green : T.amber}44`, color: isBtLive ? T.green : T.amber, padding:"3px 8px", borderRadius:"4px", fontSize:"10px"}}>
 {isBtLive ?"BT LIVE":"BT DEMO"}
 </span>
 <span style={{ background: isScanLive ?"#00330f":"#2a1e00", border:`1px solid ${isScanLive ? T.green : T.amber}44`, color: isScanLive ? T.green : T.amber, padding:"3px 8px", borderRadius:"4px", fontSize:"10px"}}>
 {isScanLive ?"SCAN LIVE":"SCAN DEMO"}
 </span>
 </div>
 </div>

 <div style={{ display:"flex", borderBottom:`1px solid ${T.border}`, paddingLeft: 24 }}>
 {TABS.map((t) => (
 <button key={t.id} onClick={() => setTab(t.id)} style={{ background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"11px", letterSpacing:"0.1em", padding:"12px 20px", color: tab === t.id ? T.blue : T.muted, borderBottom:`2px solid ${tab === t.id ? T.blue :"transparent"}`}}>
 {t.label}
 </button>
 ))}
 </div>

 {tab ==="backtest"&& (
 <div style={{ padding: 24 }}>
 <div style={{ display:"flex", gap: 12, marginBottom: 20, flexWrap:"wrap", alignItems:"flex-end"}}>
 <div><label style={S.label}>Ticker</label><input value={btTicker} onChange={(e) => setBtTicker(e.target.value.toUpperCase())} style={{ ...S.input, width: 100 }} /></div>
 <div><label style={S.label}>Start</label><input type="date"value={btStart} onChange={(e) => setBtStart(e.target.value)} style={{ ...S.input, width: 150 }} /></div>
 <div><label style={S.label}>End</label><input type="date"value={btEnd} onChange={(e) => setBtEnd(e.target.value)} style={{ ...S.input, width: 150 }} /></div>
 <button onClick={runBacktest} disabled={btRunning} style={{ ...S.btn, background: btRunning ? T.dim : T.blue, cursor: btRunning ?"not-allowed":"pointer", minWidth: 140 }}>
 {btRunning ?`RUNNING ${btProgress}%`:"RUN BACKTEST"}
 </button>
 {btResults && <button onClick={() => setShowLog((v) => !v)} style={{ ...S.btn, background:"transparent", border:`1px solid ${T.border}`, color: T.muted }}>{showLog ?"HIDE LOG":"SHOW LOG"}</button>}
 </div>
 {btRunning && <div style={{ marginBottom: 20, height: 3, background: T.dim, borderRadius: 2, overflow:"hidden"}}><div style={{ width:`${btProgress}%`, height:"100%", background: T.blue, transition:"width 0.2s"}} /></div>}
 {showLog && btLog.length > 0 && (
 <div ref={logRef} style={{ ...S.card, maxHeight: 160, overflowY:"auto", marginBottom: 20, fontSize:"11px", lineHeight: 1.9, color: T.muted }}>
 {btLog.map((l, i) => <div key={i}>{l}</div>)}
 </div>
 )}
 {btResults && (
 <>
 <div style={{ display:"flex", gap: 12, flexWrap:"wrap", marginBottom: 20 }}>
 <StatCard label="Win Rate"value={`${btResults.stats.winRate}%`} sub={`${btResults.stats.wins}W / ${btResults.stats.losses}L`} color={parseFloat(btResults.stats.winRate) >= 50 ? T.green : T.red} />
 <StatCard label="Signals"value={btResults.stats.total} sub={`+${btResults.stats.timeouts} timeout`} />
 <StatCard label="Avg Win"value={`+${btResults.stats.avgWin}%`} color={T.green} />
 <StatCard label="Avg Loss"value={`${btResults.stats.avgLoss}%`} color={T.red} />
 <StatCard label="Profit Factor"value={btResults.stats.pf} color={parseFloat(btResults.stats.pf) >= 1.5 ? T.green : T.amber} />
 <StatCard label="Total Return"value={`${parseFloat(btResults.stats.totalPct) >= 0 ?"+":""}${btResults.stats.totalPct}%`} color={parseFloat(btResults.stats.totalPct) >= 0 ? T.green : T.red} />
 </div>
 <div style={{ ...S.card, marginBottom: 20 }}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 12 }}>EQUITY CURVE CUMULATIVE RETURN</div>
 <ResponsiveContainer width="100%"height={200}>
 <LineChart data={btResults.curve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
 <CartesianGrid strokeDasharray="3 3"stroke={T.border} />
 <XAxis dataKey="date"tick={{ fill: T.muted, fontSize: 10 }} tickLine={false} interval={Math.max(1, Math.floor(btResults.curve.length / 6))} />
 <YAxis tick={{ fill: T.muted, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) =>`${v >= 0 ?"+":""}${v}%`} />
 <Tooltip content={<ChartTip />} />
 <Line type="monotone"dataKey="cumPct"stroke={T.blue} strokeWidth={2} dot={false} />
 </LineChart>
 </ResponsiveContainer>
 </div>
 <div style={S.card}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 12 }}>TRADE LOG click any row for signal breakdown</div>
 <div style={{ overflowX:"auto"}}>
 <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"12px"}}>
 <thead>
 <tr>{["DATE","ENTRY $","GAP","SCORE","RVOL","CATALYST","RESULT","P&L"].map((h) => <th key={h} style={{ padding:"6px 10px", fontWeight: 400, fontSize:"10px", color: T.muted, textAlign:"left", borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr>
 </thead>
 <tbody>
 {btResults.trades.flatMap((t, i) => {
 const rows = [
 <tr key={i} onClick={() => setExpandRow(expandRow === i ? null : i)} style={{ borderBottom:`1px solid ${T.dim}`, cursor:"pointer", background: expandRow === i ? T.surface :"transparent"}}>
 <td style={{ padding:"7px 10px", color: T.muted }}>{t.date}</td>
 <td style={{ padding:"7px 10px"}}>${t.entryPrice?.toFixed(2)}</td>
 <td style={{ padding:"7px 10px", color: t.gap >= 0 ? T.green : T.red }}>{t.gap >= 0 ?"+":""}{t.gap}%</td>
 <td style={{ padding:"7px 10px", minWidth: 110 }}><ScoreBar score={t.score} /></td>
 <td style={{ padding:"7px 10px", color: t.rvol >= 2 ? T.green : T.muted }}>{t.rvol != null ?`${t.rvol}x`:""}</td>
 <td style={{ padding:"7px 10px"}}>{t.breakdown?.catalyst >= 25 ? <Badge result="STRONG"/> : t.breakdown?.catalyst >= 12 ? <Badge result="MODERATE"/> : <span style={{ color: T.dim }}></span>}</td>
 <td style={{ padding:"7px 10px"}}><Badge result={t.result} /></td>
 <td style={{ padding:"7px 10px", color: t.pct >= 0 ? T.green : T.red, fontWeight: 700 }}>{t.pct >= 0 ?"+":""}{t.pct?.toFixed(2)}%</td>
 </tr>
 ];
 if (expandRow === i) rows.push(<tr key={`exp${i}`}><td colSpan={8} style={{ padding:"0 10px 12px"}}><ScoreBreakdown breakdown={t.breakdown || {}} headlines={t.headlines} rvol={t.rvol} spyGap={t.spyGap} catalystSource={t.catalystSource} /></td></tr>);
 return rows;
 })}
 </tbody>
 </table>
 </div>
 </div>
 </>
 )}
 {!btResults && !btRunning && (
 <div style={{ textAlign:"center", padding:"60px 0", color: T.muted }}>
 <div style={{ fontSize:"32px", marginBottom: 12 }}></div>
 <div>Set ticker + date range RUN BACKTEST</div>
 <div style={{ fontSize:"11px", marginTop: 8, color: T.dim }}>{isDemo ?"Demo uses all 7 signals with simulated data":"Live mode active Polygon.io"}</div>
 </div>
 )}
 </div>
 )}

 {tab ==="scanner"&& (
 <div style={{ padding: 24 }}>
 <div style={{ display:"flex", gap: 12, marginBottom: 16, alignItems:"flex-end", flexWrap:"wrap"}}>
 <div style={{ flex: 1, minWidth: 180 }}>
 <label style={S.label}>Add Ticker</label>
 <input value={scanInput} onChange={(e) => setScanInput(e.target.value.toUpperCase())}
 onKeyDown={(e) => { if (e.key ==="Enter"&& scanInput.trim()) { setScanTickers((p) => [...new Set([...p, scanInput.trim()])]); setScanInput(""); } }}
 placeholder="Ticker + Enter"style={S.input} />
 </div>
 <button onClick={runScan} disabled={scanning} style={{ ...S.btn, background: scanning ? T.dim : T.blue, cursor: scanning ?"not-allowed":"pointer"}}>
 {scanning ?"SCANNING...":"SCAN NOW"}
 </button>
 </div>
 <div style={{ display:"flex", gap: 8, flexWrap:"wrap", marginBottom: 20 }}>
 {scanTickers.map((tk) => (
 <div key={tk} style={{ background: T.panel, border:`1px solid ${T.border}`, borderRadius: 6, padding:"4px 10px", display:"flex", gap: 8, alignItems:"center"}}>
 <span>{tk}</span>
 <button onClick={() => setScanTickers((p) => p.filter((t) => t !== tk))} style={{ background:"none", border:"none", color: T.muted, cursor:"pointer", fontSize:"14px", padding:"0 4px", fontWeight:"bold" }}>×</button>
 </div>
 ))}
 </div>
 {scanResults && (
 <div style={S.card}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 12 }}>{isDemo ?"DEMO ADD POLYGON/ALPACA KEY FOR LIVE":`LIVE ${new Date().toLocaleTimeString()}`}</div>
 <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"12px"}}>
 <thead>
 <tr>{["TICKER","SCORE","GAP","RVOL","CATALYST","SPY PM","SIGNAL"].map((h) => <th key={h} style={{ padding:"6px 12px", fontWeight: 400, fontSize:"10px", color: T.muted, textAlign:"left", borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr>
 </thead>
 <tbody>
 {scanResults.flatMap((r, i) => {
 const rows = [
 <tr key={i} onClick={() => setExpandScan(expandScan === i ? null : i)} style={{ borderBottom:`1px solid ${T.dim}`, cursor:"pointer", background: expandScan === i ? T.surface :"transparent"}}>
 <td style={{ padding:"10px 12px", fontWeight: 700 }}>{r.ticker}</td>
 <td style={{ padding:"10px 12px", minWidth: 120 }}><ScoreBar score={r.score} /></td>
 <td style={{ padding:"10px 12px", color: r.gap >= 0 ? T.green : T.red }}>{r.gap >= 0 ?"+":""}{r.gap}%</td>
 <td style={{ padding:"10px 12px", color: r.rvol >= 2 ? T.green : T.muted }}>{r.rvol != null ?`${r.rvol}x`:""}</td>
 <td style={{ padding:"10px 12px"}}>{r.breakdown?.catalyst >= 25 ? <Badge result="STRONG"/> : r.breakdown?.catalyst >= 12 ? <Badge result="MODERATE"/> : <span style={{ color: T.dim }}></span>}</td>
 <td style={{ padding:"10px 12px", color: r.spyGap >= 0 ? T.green : T.red }}>{r.spyGap != null ?`${r.spyGap >= 0 ?"+":""}${r.spyGap}%`:""}</td>
 <td style={{ padding:"10px 12px"}}><Badge result={r.signal} /></td>
 </tr>
 ];
 if (expandScan === i) rows.push(<tr key={`es${i}`}><td colSpan={7} style={{ padding:"0 12px 14px"}}><ScoreBreakdown breakdown={r.breakdown || {}} headlines={r.headlines} rvol={r.rvol} spyGap={r.spyGap} catalystSource={r.catalystSource} /></td></tr>);
 return rows;
 })}
 </tbody>
 </table>
 </div>
 )}
 {!scanResults && !scanning && (
 <div style={{ textAlign:"center", padding:"60px 0", color: T.muted }}>
 <div style={{ fontSize:"32px", marginBottom: 12 }}></div>
 <div>Add tickers and hit SCAN NOW</div>
 <div style={{ fontSize:"11px", marginTop: 8 }}>Best run 4:009:30 AM ET click any row to expand breakdown</div>
 </div>
 )}
 </div>
 )}

 {tab ==="settings"&& (
 <div style={{ padding: 24, maxWidth: 560 }}>
 <div style={{ ...S.card, marginBottom: 16 }}>
 <div style={{ fontSize:"11px", color: T.amber, marginBottom: 16 }}> API KEYS leave blank for demo mode</div>
 <div style={{ marginBottom: 14 }}>
 <label style={S.label}>Polygon.io Key pre-market bars SPY context avg volume (Backtest)</label>
 <input type="password"value={settings.polygonKey} onChange={(e) => setSettings((s) => ({ ...s, polygonKey: e.target.value }))} placeholder="Polygon key..."style={S.input} />
 <div style={{ fontSize:"10px", color: T.muted, marginTop: 4 }}>Free plan works for backtesting. Rate-limited to 5 calls/min.</div>
 </div>
 <div style={{ marginBottom: 14 }}>
 <label style={S.label}>FMP Key real earnings beats analyst upgrades (Optional)</label>
 <input type="password"value={settings.fmpKey} onChange={(e) => setSettings((s) => ({ ...s, fmpKey: e.target.value }))} placeholder="FMP key..."style={S.input} />
 <div style={{ fontSize:"10px", color: T.muted, marginTop: 4 }}>Optional. Free plan works. Upgrades catalyst from keyword matching to real EPS beat % and analyst data.</div>
 </div>
 <div style={{ marginBottom: 14 }}>
 <label style={S.label}>Alpaca Key ID PRIMARY live scanner source (FREE)</label>
 <input type="password"value={settings.alpacaId} onChange={(e) => setSettings((s) => ({ ...s, alpacaId: e.target.value }))} placeholder="Alpaca key ID..."style={S.input} />
 <div style={{ fontSize:"10px", color: T.muted, marginTop: 4 }}>Free paper account at alpaca.markets 4am8pm extended hours in real time. No credit card needed.</div>
 </div>
 <div>
 <label style={S.label}>Alpaca Secret Key</label>
 <input type="password"value={settings.alpacaSecret} onChange={(e) => setSettings((s) => ({ ...s, alpacaSecret: e.target.value }))} placeholder="Alpaca secret..."style={S.input} />
 </div>
 </div>
 <div style={{ ...S.card, marginBottom: 16 }}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 14 }}>TRADE LOGIC</div>
 <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap: 12 }}>
 <div><label style={S.label}>Win Target %</label><input type="number"step="0.1"min="0.5"max="20"value={settings.winPct} onChange={(e) => setSettings((s) => ({ ...s, winPct: parseFloat(e.target.value) }))} style={S.input} /></div>
 <div><label style={S.label}>Stop Loss %</label><input type="number"step="0.1"min="0.1"max="5"value={settings.lossPct} onChange={(e) => setSettings((s) => ({ ...s, lossPct: parseFloat(e.target.value) }))} style={S.input} /></div>
 <div><label style={S.label}>Min Score</label><input type="number"step="1"min="0"max="95"value={settings.minScore} onChange={(e) => setSettings((s) => ({ ...s, minScore: parseInt(e.target.value) }))} style={S.input} /></div>
 </div>
 </div>
 <div style={S.card}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 14 }}>7-SIGNAL GUIDE</div>
 {[
 { icon:"", name:"Catalyst", max: 25, note:"Earnings beat=25 Analyst upgrade=12 News=5 None=0"},
 { icon:"", name:"Relative Volume", max: 20, note:"Projected day vol vs 30-day avg. 3x RVOL 20pts"},
 { icon:"", name:"Gap %", max: 20, note:"Pre-market vs prev close. 6%+ gap = full 20pts"},
 { icon:"", name:"PM Momentum", max: 10, note:"Last 30 PM bars trending up"},
 { icon:"", name:"Market Context", max: 10, note:"SPY PM green=10 flat=5 red=0"},
 { icon:"", name:"PM Consistency", max: 5, note:"% of green candles pre-market"},
 { icon:"", name:"Short Interest", max: 5, note:"High SI = squeeze potential (neutral 2.5 if N/A)"},
 ].map(({ icon, name, max, note }) => (
 <div key={name} style={{ display:"flex", gap: 10, marginBottom: 10 }}>
 <span style={{ fontSize:"14px", minWidth: 20 }}>{icon}</span>
 <div><div style={{ fontSize:"12px", color: T.text, marginBottom: 2 }}>{name} <span style={{ color: T.muted, fontSize:"10px"}}>/{max}pts</span></div><div style={{ fontSize:"10px", color: T.muted }}>{note}</div></div>
 </div>
 ))}
 <div style={{ marginTop: 12, padding: 10, background: T.bg, borderRadius: 6, fontSize:"11px", color: T.muted, lineHeight: 1.8 }}>
 <span style={{ color: T.amber }}>Tip:</span> Set min score 5565 for selective signals. Score 70+ = act. Score 80+ = full size.
 </div>
 </div>
 </div>
 )}
 </div>
 );
}

export default function App(){
  var [mounted,setMounted]=useState(false);
  useEffect(function(){setMounted(true);},[]);
  var auth=useAuth();
  var [tab,setTab]=useState("screener");
  var [topTab,setTopTab]=useState("apex");
  var [deepDiveStock,setDeepDiveStock]=useState(null);
  var [deepDiveResult,setDeepDiveResult]=useState(null);
  var [deepDiveLoading,setDeepDiveLoading]=useState(false);
  var [stocks,setStocks]=useState([]);
  var [appWatchlist,setAppWatchlist]=useState([]);
  var [tickerDetail,setTickerDetail]=useState(null);
  var [tickerAI,setTickerAI]=useState(null);
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
  var [wlReanalyzing,setWlReanalyzing]=useState(false);
  var [wlProgress,setWlProgress]=useState({done:0,total:0,ticker:""});
  function reanalyzeWatchlist(){
    if(wlReanalyzing)return;
    setWlReanalyzing(true);
    setWlProgress({done:0,total:0,ticker:"Loading..."});
    fetch("/api/portfolio?action=watchlist").then(function(r){return r.json();}).then(function(data){
      if(!Array.isArray(data)||!data.length){setWlReanalyzing(false);return;}
      var tickers=data.map(function(w){return w.ticker;});
      var total=tickers.length;
      setWlProgress({done:0,total:total,ticker:tickers[0]||""});
      var today=new Date().toDateString();
      var idx=0;
      function next(){
        if(idx>=tickers.length){
          setWlReanalyzing(false);
          setWlProgress({done:total,total:total,ticker:"Done!"});
          setTimeout(function(){setWlProgress({done:0,total:0,ticker:""});refreshWatchlist();},1500);
          return;
        }
        var ticker=tickers[idx++];
        setWlProgress({done:idx-1,total:total,ticker:ticker});
        var prompt="Today is "+today+". Analyze "+ticker+" as an investment. This stock is on our watchlist as a potential overreaction play. "+
          "Return a JSON object with fields: ticker (string), verdict (Strong Overreaction|Overreaction|Partial Overreaction|Mixed|Justified), "+
          "catalyst (string, 2 sentences), bull_case (string, 3 sentences), bear_case (string, 3 sentences), "+
          "analyst_target (string like $XXX), upside (string like +X%), upside_num (number), "+
          "recommendation (Strong Buy|Buy|Watch|Avoid), drop_pct (number, estimated drop from high), "+
          "price_str (string like $XXX), market_cap (string like $XXXb), "+
          "recovery_probability (High|Medium|Low), recovery_timeline (string like '3-6 months'), "+
          "summary (string, 3 sentences). Return ONLY the JSON object.";
        fetch("/api/analyze",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:600,
            system:"You are a financial analyst. Return ONLY a valid JSON object, no markdown, no explanation.",
            messages:[{role:"user",content:prompt}]})
        }).then(function(r){return r.json();}).then(function(d){
          var txt=(d.content||[]).map(function(b){return b.text||"";}).join("").trim();
          try{
            var clean=txt.replace(/```json|```/g,"").trim();
            var parsed=JSON.parse(clean);
            if(parsed.ticker){
              fetch("/api/portfolio?action=ai_analysis",{method:"POST",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({results:[parsed],category:"watchlist_refresh"})
              }).catch(function(){});
            }
          }catch(e){}
          setTimeout(next,1200);
        }).catch(function(){setTimeout(next,1200);});
      }
      next();
    }).catch(function(){setWlReanalyzing(false);});
  }
  function refreshWatchlist(){
    fetch("/api/portfolio?action=watchlist").then(function(r){return r.json();}).then(function(data){
      setAppWatchlist(Array.isArray(data)?data:[]);
      if(!data||!data.length)return;
      var today=new Date(),from365=new Date(today-365*24*60*60*1000),from90=new Date(today-90*24*60*60*1000);
      var toStr=today.toISOString().slice(0,10),from365Str=from365.toISOString().slice(0,10);
      Promise.all([
        Promise.all(data.map(function(w){
          return Promise.all([
            fetch("/api/market?source=fmp_fh&endpoint=quote&fh_endpoint=quote&symbol="+w.ticker).then(function(r){return r.json();}).catch(function(){return {};}),
            fetch("/api/market?source=fh&endpoint=stock/recommendation?symbol="+w.ticker).then(function(r){return r.json();}).catch(function(){return [];}),
            fetch("/api/market?source=fmp&endpoint=ratios-ttm&symbol="+w.ticker).then(function(r){return r.json();}).catch(function(){return [];}),
            fetch("/api/edgar?ticker="+w.ticker).then(function(r){return r.json();}).catch(function(){return null;}),
          ]).then(function(res){return{ticker:w.ticker,name:w.name||w.ticker,q:res[0],rec:res[1],ratios:res[2],edgar:res[3]};});
        })),
        Promise.all(data.map(function(w){
          return fetch("/api/market?source=fmp&endpoint=historical-price-eod/full&symbol="+w.ticker+"&from="+from365Str+"&to="+toStr)
            .then(function(r){return r.json();}).catch(function(){return [];});
        })),
        fetch("/api/portfolio?action=history").then(function(r){return r.json();}).catch(function(){return [];})
      ]).then(function(all){
        var fhResults=all[0],histResults=all[1],aiHistory=Array.isArray(all[2])?all[2]:[];
        var aiByTicker={};
        aiHistory.forEach(function(a){if(!aiByTicker[a.ticker])aiByTicker[a.ticker]=a;});
        var ns=fhResults.map(function(r,idx){
          var cur=r.q&&r.q.c?r.q.c:0;
          var prev=r.q&&r.q.pc?r.q.pc:cur;
          var chg=prev>0?((cur-prev)/prev*100):0;
          var hist=Array.isArray(histResults[idx])?histResults[idx].sort(function(a,b){return new Date(a.date)-new Date(b.date);}):[];
          var closes=hist.map(function(h){return h.close;});
          var hi52=closes.length?Math.max.apply(null,closes):0;
          var lo52=closes.length?Math.min.apply(null,closes):0;
          var hist90=hist.filter(function(h){return new Date(h.date)>=from90;});
          var sparkPrices=hist90.map(function(h){return h.close;});
          var change3M=sparkPrices.length>=2?+((sparkPrices[sparkPrices.length-1]-sparkPrices[0])/sparkPrices[0]*100).toFixed(1):null;
          var recData=Array.isArray(r.rec)&&r.rec.length>0?r.rec[0]:null;
          var buyPct=recData?Math.round(((recData.buy||0)+(recData.strongBuy||0))/((recData.buy||0)+(recData.hold||0)+(recData.sell||0)+(recData.strongBuy||0)+(recData.strongSell||0)||1)*100):null;
          var ratiosArr=Array.isArray(r.ratios)?r.ratios:[];
          var ratioData=ratiosArr.length>0?ratiosArr[0]:null;
          var livePeratio=ratioData&&(ratioData.peRatioTTM||ratioData.priceToEarningsRatioTTM)?+parseFloat(ratioData.peRatioTTM||ratioData.priceToEarningsRatioTTM).toFixed(1):null;
          var edgarRevs=(r.edgar&&Array.isArray(r.edgar.revenues))?r.edgar.revenues:[];
          var revenueGrowth=null;
          if(edgarRevs.length>=2){
            var revLatest=edgarRevs[edgarRevs.length-1].val,revPrev=edgarRevs[edgarRevs.length-2].val;
            if(revPrev>0)revenueGrowth=+((revLatest-revPrev)/revPrev*100).toFixed(1);
          }
          var ai=aiByTicker[r.ticker]||null;
          var dip=hi52>0?+((hi52-cur)/hi52*100).toFixed(1):0;
          return{ticker:r.ticker,name:r.name,cur:+cur.toFixed(2),chg:+chg.toFixed(2),
            hi52,lo52,buyPct,dip,sparkPrices,change3M,
            livePeratio,revenueGrowth,
            verdict:ai?ai.verdict:null,catalyst:ai?ai.catalyst:null,
            bull:ai?ai.bull_case:null,bear:ai?ai.bear_case:null,
            analystTarget:ai?ai.analyst_target:null,upside:ai?ai.upside:null,
            recommendation:ai?ai.recommendation:null,dropPct:ai?ai.drop_pct:null,
            recoveryProb:ai?ai.recovery_probability:null,
            recoveryTimeline:ai?ai.recovery_timeline:null,
            multiTfAnalysis:ai?ai.multi_tf_analysis:null,
            selectedTfChange:ai?ai.selected_tf_change:null,
            aiMarketCap:ai?ai.market_cap:null,
            aiPrice:ai?ai.price_str:null,
            aiAnalyzedAt:ai?ai.analyzed_at:null,
          };
        });
        ns.forEach(function(w){
          var tgt=w.analystTarget?parseFloat(w.analystTarget.toString().replace(/[^0-9.]/g,"")):0;
          var price=w.cur||0;
          if(tgt>0&&price>0){
            if(tgt<price*0.97){
              w.recommendation="Avoid";
              w.analystTarget="$"+tgt.toFixed(0);
              var u=+((tgt-price)/price*100).toFixed(0);
              w.upside=u+"%";
              if(w.verdict==="Strong Overreaction"||w.verdict==="Overreaction") w.verdict="Justified";
            } else {
              var u2=+((tgt-price)/price*100).toFixed(0);
              w.upside=(u2>=0?"+":"")+u2+"%";
              w.analystTarget="$"+tgt.toFixed(0);
            }
          }
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
  var [wlDetail,setWlDetail]=useState(null);
  var [srt,setSrt]=useState("score");
  var [lastR,setLastR]=useState(null);
  var [apOn,setApOn]=useState(false);
  var [apLog,setApLog]=useState([]);
  var [tuneLog,setTuneLog]=useState([]);
  var [apStats,setApStats]=useState({trades:0,tunes:0});
  var [apCountdown,setApCountdown]=useState(AP_SEC);
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
  var [dataSource,setDataSource]=useState("loading");

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
    var cacheKey="apex_quotes_daily";
    var cached=null;
    try{
      var cv=localStorage.getItem(cacheKey);
      if(cv){var cp=JSON.parse(cv);var sameDay=new Date(cp.ts).toDateString()===new Date().toDateString();if(sameDay&&!forceRefresh)cached=cp.data;}
    }catch(e){}
    if(cached){setDataLoading(false);setDataSource("live");buildStocks(cached,c);return;}
    setDataLoading(true);setDataSource("live");
    Promise.all(TICKERS.map(function(t){
      return fetch("/api/market?source=fmp_fh&endpoint=quote&fh_endpoint=quote&symbol="+t)
        .then(function(r){return r.json();}).catch(function(){return null;})
        .then(function(q){
          var m=q&&q.hi52?{metric:{"52WeekHigh":q.hi52,"52WeekLow":q.lo52,"10DayAverageTradingVolume":q.avgVol?q.avgVol/1e6:null,"3MonthAverageTradingVolume":q.avgVol?q.avgVol/1e6:null,"peExclExtraTTM":q.pe,"beta":q.beta}}:null;
          return {ticker:t,q,m};
        });
    })).then(function(results){
      var batch={};
      results.forEach(function(r){
        if(r.q&&r.q.c>0){
          var hi52=r.m&&r.m.metric&&r.m.metric["52WeekHigh"]?r.m.metric["52WeekHigh"]:null;
          var lo52=r.m&&r.m.metric&&r.m.metric["52WeekLow"]?r.m.metric["52WeekLow"]:null;
          var avgVol10d=r.m&&r.m.metric&&r.m.metric["10DayAverageTradingVolume"]?r.m.metric["10DayAverageTradingVolume"]*1e6:null;
          var avgVol3m=r.m&&r.m.metric&&r.m.metric["3MonthAverageTradingVolume"]?r.m.metric["3MonthAverageTradingVolume"]*1e6:null;
          if(hi52&&lo52)batch[r.ticker]={close:r.q.c,prevClose:r.q.pc,chgPct:r.q.dp,hi52,lo52,vol:avgVol10d,avgVol:avgVol3m};
        }
      });
      if(Object.keys(batch).length===0){setDataLoading(false);setDataSource("error");setStocks([]);return;}
      var today=new Date(),from90=new Date(today-90*24*60*60*1000);
      var fromStr=from90.toISOString().slice(0,10),toStr=today.toISOString().slice(0,10);
      var fmpSymbols=Object.keys(batch);
      Promise.all(fmpSymbols.map(function(sym){
        return fetch("/api/market?source=fmp&endpoint=historical-price-eod/full&symbol="+sym+"&from="+fromStr+"&to="+toStr)
          .then(function(r){return r.json();}).catch(function(){return [];});
      })).then(function(results){
        return [].concat.apply([],results.map(function(r){return Array.isArray(r)?r:[];}));
      })
        .then(function(histData){
          var histByTicker={};
          if(Array.isArray(histData)){
            histData.forEach(function(row){if(row.symbol&&row.close){histByTicker[row.symbol]=histByTicker[row.symbol]||[];histByTicker[row.symbol].push(parseFloat(row.close));}});
          }
          var ns=TICKERS.map(function(t,i){
            var q=batch[t];
            if(!q)return null;
            var cur=q.close,chg=q.chgPct||0;
            var h52hi=q.hi52,h52lo=q.lo52;
            var vr=q.vol&&q.avgVol&&q.avgVol>0?+(q.vol/q.avgVol).toFixed(2):1;
            var dip=(h52hi-cur)/h52hi*100;
            var prices=histByTicker[t]&&histByTicker[t].length>=20?histByTicker[t].slice().reverse():null;
            if(!prices){
              prices=[];
              for(var d=0;d<90;d++){
                var hash=t.split("").reduce(function(a,ch){return a+ch.charCodeAt(0);},0);
                var progress=d/89;
                var base=h52lo+(cur-h52lo)*Math.pow(progress,0.7);
                var osc=((hash*d)%17-8)/8*(h52hi-h52lo)*0.04;
                prices.push(Math.max(h52lo*0.95,Math.min(h52hi*1.02,base+osc)));
              }
            }
            prices[prices.length-1]=cur;
            var rsi=lastRSI(prices),mh=macdH(prices);
            var sig="HOLD";
            if(dip>=c.dipMin&&dip<=c.dipMax){
              if(rsi>=c.rsiRecovery&&rsi<60&&mh>0&&vr>=c.volMult)sig="STRONG_BUY";
              else if(rsi>=c.rsiOversold&&mh>-0.5)sig="BUY";
              else if(rsi<c.rsiOversold)sig="WATCH";
            }else if(dip<5){if(rsi>70)sig="SELL";}
            else if(dip>25&&dip<=40){if(rsi>=c.rsiRecovery&&mh>0&&vr>=c.volMult)sig="BUY";else if(rsi>=c.rsiOversold&&mh>-0.5)sig="WATCH";else sig="SELL";}
            else if(dip>40){sig=rsi<35?"WATCH":"SELL";}
            var score=Math.min(100,Math.max(0,Math.round(
              (dip>=5&&dip<=20?30:0)+(rsi>=35&&rsi<=55?25:rsi<35?15:0)+(mh>0?25:0)+(vr>=1.3?20:vr>=1?10:0)
            )));
            return{ticker:t,prices,cur:+cur.toFixed(2),h52:+h52hi.toFixed(2),dip:+dip.toFixed(1),
              rsi,mh,chg:+parseFloat(chg).toFixed(2),vr,sig,score,sector:SECTORS[i%20],
              sl:+(cur*(1-c.sl/100)).toFixed(2),tp:+(cur*(1+c.tp/100)).toFixed(2),
              entry:"$"+(cur*0.98).toFixed(2)+"-$"+(cur*1.01).toFixed(2),isReal:true};
          }).filter(Boolean);
          if(ns.length>0){
            try{localStorage.setItem(cacheKey,JSON.stringify({ts:Date.now(),data:batch}));}catch(e){}
            setStocks(ns);setLastR(new Date());setDataLoading(false);
          } else {
            setDataLoading(false);setDataSource("error");
          }
        });
    });
    function buildStocks(batch,c){
      var today=new Date(),from90=new Date(today-90*24*60*60*1000);
      var fromStr=from90.toISOString().slice(0,10),toStr=today.toISOString().slice(0,10);
      var fmpSymbols=Object.keys(batch);
      Promise.all(fmpSymbols.map(function(sym){
        return fetch("/api/market?source=fmp&endpoint=historical-price-eod/full&symbol="+sym+"&from="+fromStr+"&to="+toStr)
          .then(function(r){return r.json();}).catch(function(){return [];});
      })).then(function(results){
        return [].concat.apply([],results.map(function(r){return Array.isArray(r)?r:[];}));
      })
        .then(function(histData){
          var histByTicker={};
          if(Array.isArray(histData)){
            histData.forEach(function(row){if(row.symbol&&row.close){histByTicker[row.symbol]=histByTicker[row.symbol]||[];histByTicker[row.symbol].push(parseFloat(row.close));}});
          }
          var ns=TICKERS.map(function(t,i){
            var q=batch[t];if(!q)return null;
            var cur=q.close,chg=q.chgPct||0;
            var h52hi=q.hi52,h52lo=q.lo52;
            var vr=q.vol&&q.avgVol&&q.avgVol>0?+(q.vol/q.avgVol).toFixed(2):1;
            var dip=(h52hi-cur)/h52hi*100;
            var prices=histByTicker[t]&&histByTicker[t].length>=20?histByTicker[t].slice().reverse():null;
            if(!prices){prices=[];for(var d=0;d<90;d++){var hash=t.split("").reduce(function(a,ch){return a+ch.charCodeAt(0);},0);var progress=d/89;var base=h52lo+(cur-h52lo)*Math.pow(progress,0.7);var osc=((hash*d)%17-8)/8*(h52hi-h52lo)*0.04;prices.push(Math.max(h52lo*0.95,Math.min(h52hi*1.02,base+osc)));}}
            prices[prices.length-1]=cur;
            var rsi=lastRSI(prices),mh=macdH(prices);
            var sig="HOLD";
            if(dip>=c.dipMin&&dip<=c.dipMax){if(rsi>=c.rsiRecovery&&rsi<60&&mh>0&&vr>=c.volMult)sig="STRONG_BUY";else if(rsi>=c.rsiOversold&&mh>-0.5)sig="BUY";else if(rsi<c.rsiOversold)sig="WATCH";}
            else if(dip<5){if(rsi>70)sig="SELL";}
            else if(dip>25&&dip<=40){if(rsi>=c.rsiRecovery&&mh>0&&vr>=c.volMult)sig="BUY";else if(rsi>=c.rsiOversold&&mh>-0.5)sig="WATCH";else sig="SELL";}
            else if(dip>40){sig=rsi<35?"WATCH":"SELL";}
            var score=Math.min(100,Math.max(0,Math.round((dip>=5&&dip<=20?30:0)+(rsi>=35&&rsi<=55?25:rsi<35?15:0)+(mh>0?25:0)+(vr>=1.3?20:vr>=1?10:0))));
            return{ticker:t,prices,cur:+cur.toFixed(2),h52:+h52hi.toFixed(2),dip:+dip.toFixed(1),rsi,mh,chg:+parseFloat(chg).toFixed(2),vr,sig,score,sector:SECTORS[i%20],sl:+(cur*(1-c.sl/100)).toFixed(2),tp:+(cur*(1+c.tp/100)).toFixed(2),entry:"$"+(cur*0.98).toFixed(2)+"-$"+(cur*1.01).toFixed(2),isReal:true};
          }).filter(Boolean);
          if(ns.length>0){setStocks(ns);setLastR(new Date());}
        });
    }
  },[]);

  useEffect(function(){refresh();},[refresh]);

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
    if(!btTicker) return;
    setBtResult(null);
    var today=new Date();
    var from365=new Date(today-365*24*60*60*1000).toISOString().slice(0,10);
    var toStr=today.toISOString().slice(0,10);
    fetch("/api/market?source=fmp&endpoint=historical-price-eod/full&symbol="+btTicker+"&from="+from365+"&to="+toStr)
      .then(function(r){return r.json();})
      .then(function(data){
        if(!Array.isArray(data)||data.length<30) return;
        var sorted=data.sort(function(a,b){return new Date(a.date)-new Date(b.date);});
        var prices=sorted.map(function(d){return d.close;});
        setBtResult(runBT(prices,cfgRef.current));
      })
      .catch(function(){});
  },[btTicker]);

  function execTrade(stock,side,q){
    var cost=stock.cur*q;
    if(side==="BUY"){
      if(port.cash<cost){notify("Insufficient cash",true);return;}
      var newCash=port.cash-cost;
      var newPos={ticker:stock.ticker,shares:q,avg:stock.cur,ep:stock.cur,sl:stock.sl,tp:stock.tp};
      setPort(function(prev){
        var np=Object.assign({},prev.pos);
        np[stock.ticker]=newPos;
        return{cash:newCash,pos:np,trades:[{id:Date.now(),ticker:stock.ticker,side:"BUY",q:q,price:stock.cur,pnl:0,time:new Date().toLocaleTimeString(),auto:false,sig:stock.sig,rsi:stock.rsi,dip:stock.dip,mh:stock.mh,vr:stock.vr,score:stock.score}].concat(prev.trades)};
      });
      fetch("/api/portfolio?action=trade",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ticker:stock.ticker,side:"BUY",quantity:q,price:stock.cur,pnl:0,reason:"Manual",auto:false,newCash:newCash,position:{sl:stock.sl,tp:stock.tp},metrics:{sig:stock.sig,rsi:stock.rsi,dip:stock.dip,mh:stock.mh,vr:stock.vr,score:stock.score}})
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
        return{cash:prev.cash-cost,pos:np,trades:[{id:Date.now(),ticker:stock.ticker,side:"BUY",q:shares,price:stock.cur,time:new Date().toLocaleTimeString(),auto:true,sig:stock.sig,rsi:stock.rsi,dip:stock.dip,mh:stock.mh,vr:stock.vr,score:stock.score}].concat(prev.trades)};
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

  function runScan(){
    var cur=stocksRef.current,p=portRef.current,c=cfgRef.current;
    var posCount=Object.keys(p.pos).length;
    var executed=[];
    Object.values(p.pos).forEach(function(pos){
      var st=cur.find(function(s){return s.ticker===pos.ticker;});
      if(!st)return;
      if(st.cur<=pos.sl){apTrade(st,"SELL",pos.shares,"Stop Loss");executed.push({type:"SELL",ticker:pos.ticker,reason:"SL hit @ $"+st.cur,color:"#ef4444"});posCount--;}
      else if(st.cur>=pos.tp){apTrade(st,"SELL",pos.shares,"Take Profit");executed.push({type:"SELL",ticker:pos.ticker,reason:"TP hit @ $"+st.cur,color:"#4ade80"});posCount--;}
    });
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
    scanCountRef.current+=1;
    if(scanCountRef.current%4===0){runTune();}
  }

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

  var TABS=topTab==="apex"?["screener","signals","paper","backtest","autopilot","ai","settings"]:[];
  var LABELS={screener:"Screener",signals:"Signals",paper:"Paper Trade",backtest:"Backtest",autopilot:"Autopilot",ai:"AI Analysis",settings:"Settings"};

  if(!mounted)return null;
  if(auth.loading)return(
    <div style={{minHeight:"100vh",background:"#030712",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'IBM Plex Mono','Courier New',monospace"}}>
      <div style={{color:"#334155",fontSize:12,letterSpacing:2}}>LOADING...</div>
    </div>
  );
  if(!auth.user)return <LoginPage />;

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
              <div style={{fontSize:9,color:"#334155",letterSpacing:2}}>{(typeof window!=="undefined"&&lastR?lastR.toLocaleTimeString():"loading...")+" - PAPER MODE"}</div>
            </div>
          </div>
          <div style={{display:"flex",gap:4,marginBottom:4}}>
            {["apex","module","edge"].map(function(m){var a=topTab===m;return(<button key={m} onClick={function(){setTopTab(m);if(m==="apex"&&topTab!=="apex")setTab("screener");}} style={{background:a?"linear-gradient(135deg,#1d4ed8,#7c3aed)":"transparent",border:"1px solid "+(a?"#1d4ed8":"#1e293b"),borderRadius:"6px 6px 0 0",padding:"5px 18px",fontSize:11,fontWeight:700,color:a?"#fff":"#475569",cursor:"pointer",letterSpacing:1}}>{m==="apex"?"APEX":m==="module"?"MODULE":"◈ EDGE"}</button>);})}
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
            <button onClick={function(){try{localStorage.removeItem("apex_quotes_daily");}catch(e){}refresh(true);}} style={{background:"transparent",border:"1px solid #1e293b",color:"#334155",borderRadius:6,padding:"6px 11px",fontSize:10}} title="Force fetch fresh prices from API">New Prices</button>
            {dataSource==="live"&&!dataLoading&&<span style={{fontSize:9,background:"#052e16",color:"#4ade80",border:"1px solid #15803d",borderRadius:4,padding:"2px 6px",marginLeft:6,letterSpacing:1}}>LIVE</span>}
            {dataSource==="error"&&<span style={{fontSize:9,background:"#1c0505",color:"#f87171",border:"1px solid #7f1d1d",borderRadius:4,padding:"2px 6px",marginLeft:6,letterSpacing:1}}>NO DATA</span>}
            <button onClick={function(){supabase.auth.signOut().finally(function(){Object.keys(localStorage).forEach(function(k){if(k.startsWith('sb-'))localStorage.removeItem(k);});window.location.href='/';});}} style={{background:"transparent",border:"1px solid #7f1d1d",color:"#f87171",borderRadius:6,padding:"6px 11px",fontSize:10}}>Sign Out</button>
            {auth.profile&&<span style={{fontSize:9,color:"#334155",borderLeft:"1px solid #0f172a",paddingLeft:10}}>{auth.profile.display_name||auth.profile.email}</span>}
          </div>
        {deepDiveStock&&(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:2000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={function(e){if(e.target===e.currentTarget){setDeepDiveStock(null);setDeepDiveResult(null);}}}>
            <div style={{background:"#0a0f1a",border:"1px solid #7c3aed",borderRadius:16,width:"100%",maxWidth:560,maxHeight:"85vh",overflowY:"auto",padding:"24px 26px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
                <div><div style={{fontSize:22,fontWeight:800,color:"#f1f5f9"}}>{deepDiveStock.ticker} Deep Dive</div><div style={{fontSize:11,color:"#475569",marginTop:3}}>Second-opinion with self-verification</div></div>
                <button onClick={function(){setDeepDiveStock(null);setDeepDiveResult(null);}} style={{background:"transparent",border:"1px solid #334155",color:"#64748b",borderRadius:6,padding:"6px 12px",cursor:"pointer",fontSize:16}}>x</button>
              </div>
              {deepDiveLoading&&(<div style={{display:"flex",gap:12,padding:"30px 0",justifyContent:"center"}}><div style={{fontSize:13,color:"#94a3b8"}}>Performing deep analysis...</div></div>)}
              {deepDiveResult&&!deepDiveLoading&&(function(){
                var r=deepDiveResult;
                if(r.error) return(<div style={{color:"#f87171",padding:20}}>{r.error}</div>);
                var rcc=r.recommendation==="Strong Buy"||r.recommendation==="Buy"?"#4ade80":r.recommendation==="Watch"?"#f59e0b":"#f87171";
                return(<div>
                  {r.verdictChanged&&(<div style={{background:"#1c0505",border:"1px solid #7f1d1d",borderRadius:8,padding:"10px 14px",marginBottom:14}}><span style={{fontSize:12,color:"#fca5a5",fontWeight:600}}>Verdict revised: {r.changeReason}</span></div>)}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
                    <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:800,background:"#0f172a",border:"1px solid #334155",color:"#f1f5f9"}}>{r.verdict}</span>
                    <span style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:700,background:"#0f172a",border:"1px solid #1e293b",color:rcc}}>{r.recommendation}</span>
                  </div>
                  {r.finalCall&&(<div style={{background:"#030712",border:"1px solid #7c3aed",borderRadius:8,padding:"12px 14px",marginBottom:12}}><div style={{fontSize:9,color:"#a78bfa",letterSpacing:2,marginBottom:6}}>FINAL CALL</div><div style={{fontSize:13,color:"#e2e8f0",lineHeight:1.7}}>{r.finalCall}</div></div>)}
                </div>);
              })()}
            </div>
          </div>
        )}
        </div>
      </div>

      <div style={{maxWidth:1200,margin:"0 auto",padding:"20px 20px 0"}}>

        {topTab==="module"&&<ArbTab/>}
{topTab==="edge"&&<PreMarketEdge/>}
{topTab==="apex"&&tab==="screener"&&(
          <div style={{animation:"fu 0.3s ease"}}>
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
                <div style={{padding:"20px 20px 16px",borderBottom:"1px solid #0f172a",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
                      <span style={{fontSize:24,fontWeight:800,color:"#f1f5f9"}}>{s.ticker}</span>
                      <span style={{padding:"4px 10px",borderRadius:5,fontSize:11,fontWeight:800,background:sg.bg,color:sg.c,border:"1px solid "+sg.b}}>{sg.label}</span>
                    </div>
                    <div style={{fontSize:11,color:"#475569"}}>{s.sector}  |  ${s.cur}  |  Score {s.score}/100</div>
                  </div>
                  <button onClick={function(){setTickerDetail(null);setTickerAI(null);}}
                    style={{background:"transparent",border:"none",color:"#475569",fontSize:18,cursor:"pointer",padding:"4px 8px"}}>x</button>
                </div>
                <div style={{padding:"16px 20px",borderBottom:"1px solid #0f172a"}}>
                  <div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:14}}>SIGNAL BREAKDOWN</div>
                  <Gauge label="DIP FROM 52W HIGH" display={s.dip.toFixed(1)+"%"} pct={dipPct} isGood={true} goodMin={17} goodMax={67} note={"Target: 5-20%  |  52W High: $"+s.h52}/>
                  <Gauge label="RSI (14)" display={s.rsi} pct={rsiPct} isGood={true} goodMin={35} goodMax={55} note="Buy zone: 35-55  |  Oversold <35  |  Overbought >70"/>
                  <Gauge label="MACD HISTOGRAM" display={(s.mh>0?"+":"")+s.mh} pct={macdPct} isGood={true} goodMin={50} goodMax={100} note={s.mh>0?"Bullish momentum":"Bearish momentum"}/>
                  <Gauge label="VOLUME VS AVERAGE" display={s.vr+"x"} pct={vrPct} isGood={true} goodMin={43} goodMax={100} note={"Target: >1.3x average  |  Current: "+s.vr+"x"}/>
                  <Gauge label="52-WEEK RANGE POSITION" display={Math.round(h52pos)+"%"} pct={h52pos} isGood={true} goodMin={0} goodMax={40} note={"Low: $"+(s.h52*0.7).toFixed(0)+" to High: $"+s.h52}/>
                  <Gauge label="1-DAY CHANGE" display={(s.chg>0?"+":"")+s.chg+"%"} pct={chgPct} isGood={true} goodMin={45} goodMax={65} note="Neutral around 0%"/>
                  <Gauge label="COMPOSITE SCORE" display={s.score+"/100"} pct={scorePct} isGood={true} goodMin={60} goodMax={100} note="Weighted: DIP 30pts  |  RSI 25pts  |  MACD 25pts  |  VOL 20pts"/>
                </div>
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
          {tickerDetail&&<div onClick={function(){setTickerDetail(null);setTickerAI(null);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,zIndex:999}}/>}

          {wlDetail&&(
            <div style={{position:"fixed",top:0,right:0,width:380,height:"100vh",background:"#0a0f1a",borderLeft:"1px solid #1e293b",zIndex:1000,overflowY:"auto",boxShadow:"-4px 0 24px rgba(0,0,0,0.5)"}}>
              <div style={{padding:"20px 22px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:18}}>
                  <div><div style={{fontSize:26,fontWeight:800,color:"#f1f5f9"}}>{wlDetail.ticker}</div><div style={{fontSize:12,color:"#475569",marginTop:2}}>{wlDetail.name}</div></div>
                  <button onClick={function(){setWlDetail(null);}} style={{background:"transparent",border:"1px solid #1e293b",color:"#475569",borderRadius:6,padding:"6px 10px",cursor:"pointer",fontSize:13}}>x</button>
                </div>
                <div style={{display:"flex",gap:12,alignItems:"center",marginBottom:16}}>
                  <div style={{fontSize:22,fontWeight:700,color:"#f1f5f9"}}>{"$"+wlDetail.cur}</div>
                  <div style={{fontSize:13,fontWeight:600,color:wlDetail.chg>=0?"#22c55e":"#ef4444"}}>{(wlDetail.chg>=0?"+":"")+wlDetail.chg+"%"}</div>
                </div>
                {wlDetail.catalyst&&(<div style={{background:"#030712",border:"1px solid #0f172a",borderRadius:8,padding:"12px 14px",marginBottom:10}}><div style={{fontSize:9,color:"#334155",letterSpacing:2,marginBottom:6}}>CATALYST</div><div style={{fontSize:12,color:"#94a3b8",lineHeight:1.7}}>{wlDetail.catalyst}</div></div>)}
                {wlDetail.bull&&<div style={{background:"#030e05",border:"1px solid #14532d",borderRadius:8,padding:"12px 14px",marginBottom:8}}><div style={{fontSize:9,color:"#16a34a",letterSpacing:2,fontWeight:700,marginBottom:6}}>BULL CASE</div><div style={{fontSize:12,color:"#86efac",lineHeight:1.6}}>{wlDetail.bull}</div></div>}
                {wlDetail.bear&&<div style={{background:"#0e0303",border:"1px solid #7f1d1d",borderRadius:8,padding:"12px 14px",marginBottom:16}}><div style={{fontSize:9,color:"#b91c1c",letterSpacing:2,fontWeight:700,marginBottom:6}}>BEAR CASE</div><div style={{fontSize:12,color:"#fca5a5",lineHeight:1.6}}>{wlDetail.bear}</div></div>}
                <button onClick={function(){setModal(Object.assign({},wlDetail,{side:"BUY",sl:+(wlDetail.cur*(1-0.07)).toFixed(2),tp:+(wlDetail.cur*(1+0.20)).toFixed(2)}));setTab("paper");setQty(1);setWlDetail(null);}} style={{width:"100%",background:"#15803d",border:"none",color:"#fff",borderRadius:8,padding:"12px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Paper Buy {wlDetail.ticker}</button>
              </div>
            </div>
          )}
          {wlDetail&&<div onClick={function(){setWlDetail(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.3)",zIndex:999}}/>}

          {appWatchlist.length>0&&(
            <div style={{marginBottom:20}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div>
                  <div style={{fontSize:16,fontWeight:700,color:"#f1f5f9"}}>Watchlist</div>
                  <div style={{fontSize:11,color:"#334155",marginTop:2}}>{appWatchlist.length} stocks from AI Analysis</div>
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  {wlReanalyzing&&<div style={{display:"flex",flexDirection:"column",gap:2,minWidth:140}}>
                    <div style={{fontSize:9,color:"#f59e0b",letterSpacing:1}}>{"ANALYZING "+wlProgress.ticker+"..."}</div>
                    <div style={{height:3,background:"#0f172a",borderRadius:2,overflow:"hidden",width:"100%"}}>
                      <div style={{height:"100%",background:"#f59e0b",borderRadius:2,transition:"width 0.4s ease",width:wlProgress.total>0?(wlProgress.done/wlProgress.total*100)+"%":"0%"}}/>
                    </div>
                    <div style={{fontSize:9,color:"#475569"}}>{wlProgress.done}/{wlProgress.total}</div>
                  </div>}
                  <button onClick={reanalyzeWatchlist} disabled={wlReanalyzing} style={{background:"transparent",border:"1px solid #1d4ed8",color:"#60a5fa",borderRadius:6,padding:"5px 11px",fontSize:11,cursor:"pointer",opacity:wlReanalyzing?0.5:1}}>Re-run AI</button>
                  <button onClick={refreshWatchlist} style={{background:"transparent",border:"1px solid #1e293b",color:"#475569",borderRadius:6,padding:"5px 11px",fontSize:11}}>Refresh</button>
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {watchlistStocks.map(function(w){
                  var rec=w.recommendation||"HOLD";
                  var verd=w.verdict||"";
                  var vs=VS[verd]||{c:"#94a3b8",bg:"#0f172a",b:"#334155"};
                  var rc2=rec==="Strong Buy"?"#22c55e":rec==="Buy"?"#4ade80":rec==="Watch"?"#f59e0b":"#f87171";
                  var up=(w.chg||0)>=0;
                  return(
                    <div key={w.ticker} onClick={function(){setWlDetail(w);}}
                      style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"14px 16px",marginBottom:8,cursor:"pointer"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                        <div style={{display:"flex",gap:12,alignItems:"center"}}>
                          <div><div style={{fontSize:16,fontWeight:800,color:"#f1f5f9"}}>{w.ticker}</div><div style={{fontSize:10,color:"#334155",marginTop:1}}>{w.name}</div></div>
                          <div><div style={{fontSize:15,fontWeight:700,color:"#94a3b8"}}>{"$"+(w.cur||0).toFixed(2)}</div><div style={{fontSize:10,color:up?"#22c55e":"#ef4444",marginTop:1}}>{(up?"+":"")+(w.chg||0).toFixed(2)+"%"}</div></div>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6}}>
                          {verd&&<span style={{padding:"4px 10px",borderRadius:5,fontSize:9,fontWeight:800,background:vs.bg,color:vs.c,border:"1px solid "+vs.b}}>{verd}</span>}
                          <span style={{padding:"4px 10px",borderRadius:5,fontSize:10,fontWeight:800,background:"#0f172a",color:rc2,border:"1px solid "+rc2}}>{rec}</span>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:16,alignItems:"center"}}>
                        <Spark prices={w.sparkPrices||[]} up={up}/>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,flex:1}}>
                          <div><div style={{fontSize:9,color:"#334155",letterSpacing:1}}>DIP</div><div style={{fontSize:12,fontWeight:700,color:"#f59e0b"}}>{(w.dip||0).toFixed(1)+"%"}</div></div>
                          <div><div style={{fontSize:9,color:"#334155",letterSpacing:1}}>3M CHG</div><div style={{fontSize:12,fontWeight:700,color:(w.change3M||0)>=0?"#4ade80":"#ef4444"}}>{w.change3M!==null?(((w.change3M||0)>=0?"+":"")+(w.change3M||0).toFixed(1)+"%"):"N/A"}</div></div>
                          <div><div style={{fontSize:9,color:"#334155",letterSpacing:1}}>P/E</div><div style={{fontSize:12,fontWeight:700,color:"#94a3b8"}}>{w.livePeratio||"N/A"}</div></div>
                          <div><div style={{fontSize:9,color:"#334155",letterSpacing:1}}>TARGET</div><div style={{fontSize:11,color:"#475569"}}>{w.analystTarget||"N/A"}</div></div>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
                        {w.recoveryProb&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:4,background:"#0f172a",color:w.recoveryProb==="High"?"#4ade80":w.recoveryProb==="Medium"?"#f59e0b":"#f87171",border:"1px solid #1e293b"}}>{"PROB: "+w.recoveryProb}</span>}
                        {w.recoveryTimeline&&<span style={{fontSize:9,padding:"3px 8px",borderRadius:4,background:"#0f172a",color:"#64748b",border:"1px solid #1e293b"}}>{w.recoveryTimeline}</span>}
                        <button onClick={function(e){e.stopPropagation();fetch("/api/portfolio?action=watchlist_remove",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ticker:w.ticker})}).then(function(){refreshWatchlist();});}} style={{marginLeft:"auto",background:"transparent",border:"1px solid #1e293b",color:"#334155",borderRadius:4,padding:"2px 8px",fontSize:9,cursor:"pointer"}}>Remove</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {stocks.length>0&&(
            <div style={{marginTop:20}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
                <div style={{fontSize:11,color:"#475569"}}>{lastR&&("Updated: "+lastR.toLocaleTimeString())}</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {["all","buy","watch","sell"].map(function(f){return(
                    <button key={f} onClick={function(){setSf(f);}}
                      style={{background:sf===f?"#1e293b":"transparent",border:"1px solid "+(sf===f?"#334155":"#0f172a"),borderRadius:6,padding:"5px 12px",fontSize:11,fontWeight:600,color:sf===f?"#f1f5f9":"#334155",cursor:"pointer",textTransform:"capitalize"}}>{f}</button>
                  );})}
                  {[["score","Score"],["dip","DIP"],["rsi","RSI"]].map(function(s){return(
                    <button key={s[0]} onClick={function(){setSrt(s[0]);}}
                      style={{background:srt===s[0]?"#1e293b":"transparent",border:"1px solid "+(srt===s[0]?"#334155":"#0f172a"),borderRadius:6,padding:"5px 12px",fontSize:11,fontWeight:600,color:srt===s[0]?"#f1f5f9":"#334155",cursor:"pointer"}}>{s[1]}</button>
                  );})}
                </div>
              </div>
              {stocks
                .filter(function(s){if(sf==="all")return true;if(sf==="buy")return s.sig==="STRONG_BUY"||s.sig==="BUY";if(sf==="watch")return s.sig==="WATCH";if(sf==="sell")return s.sig==="SELL"||s.sig==="STRONG_SELL";return true;})
                .sort(function(a,b){if(srt==="dip")return b.dip-a.dip;if(srt==="rsi")return a.rsi-b.rsi;return b.score-a.score;})
                .map(function(s,idx){
                  var sg=SIGS[s.sig]||SIGS.HOLD;
                  var up=s.chg>=0;
                  return(
                    <div key={s.ticker} onClick={function(){openTickerDetail(s);}}
                      style={{background:"#0a0f1a",border:"1px solid "+(tickerDetail&&tickerDetail.ticker===s.ticker?"#1d4ed8":"#0f172a"),borderRadius:12,padding:"14px 16px",marginBottom:8,cursor:"pointer"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                        <div style={{display:"flex",gap:12,alignItems:"center"}}>
                          <div><div style={{fontSize:16,fontWeight:800,color:"#f1f5f9"}}>{s.ticker}</div><div style={{fontSize:10,color:"#334155",marginTop:1}}>{s.sector}</div></div>
                          <div><div style={{fontSize:15,fontWeight:700,color:"#94a3b8"}}>{"$"+s.cur}</div><div style={{fontSize:10,color:up?"#22c55e":"#ef4444",marginTop:1}}>{(up?"+":"")+s.chg+"%"}</div></div>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6}}>
                          <span style={{padding:"4px 10px",borderRadius:5,fontSize:10,fontWeight:800,background:sg.bg,color:sg.c,border:"1px solid "+sg.b}}>{sg.label}</span>
                          <div style={{fontSize:10,color:"#334155"}}>{"Score: "+s.score+"/100"}</div>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:16,alignItems:"center"}}>
                        <Spark prices={s.prices} up={s.chg>=0}/>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,flex:1}}>
                          <div><div style={{fontSize:9,color:"#334155",letterSpacing:1}}>DIP</div><div style={{fontSize:12,fontWeight:700,color:"#f59e0b"}}>{s.dip+"%"}</div></div>
                          <div><div style={{fontSize:9,color:"#334155",letterSpacing:1}}>RSI</div><div style={{fontSize:12,fontWeight:700,color:s.rsi<35?"#4ade80":s.rsi>70?"#f87171":"#94a3b8"}}>{s.rsi}</div></div>
                          <div><div style={{fontSize:9,color:"#334155",letterSpacing:1}}>VOL</div><div style={{fontSize:12,fontWeight:700,color:s.vr>=1.3?"#4ade80":"#94a3b8"}}>{s.vr+"x"}</div></div>
                          <div><div style={{fontSize:9,color:"#334155",letterSpacing:1}}>ENTRY</div><div style={{fontSize:11,color:"#475569"}}>{s.entry}</div></div>
                        </div>
                      </div>
                    </div>
                  );
                })
              }
            </div>
          )}
          </div>
        )}

        {topTab==="apex"&&tab==="signals"&&(
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
                    <button onClick={function(){setModal(Object.assign({},s,{side:buy?"BUY":"SELL"}));setTab("paper");setQty(1);}} style={{width:"100%",background:buy?"#15803d":"#b91c1c",border:"none",color:"#fff",borderRadius:7,padding:"9px",fontSize:12,fontWeight:700}}>{buy?"Paper Buy "+s.ticker:"Paper Sell "+s.ticker}</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {topTab==="apex"&&tab==="paper"&&(
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
                        <span>SL <span style={{color:"#f87171"}}>{"$"+p.sl}</span></span>
                        <span>TP <span style={{color:"#4ade80"}}>{"$"+p.tp}</span></span>
                        <span>Now <span style={{color:"#f1f5f9"}}>{"$"+cur}</span></span>
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

        {topTab==="apex"&&tab==="backtest"&&(
          <div style={{animation:"fu 0.3s ease"}}>
            <div style={{marginBottom:14,display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:12,alignItems:"flex-end"}}>
              <div><div style={{fontSize:20,fontWeight:700,color:"#f1f5f9"}}>Strategy Backtester</div><div style={{fontSize:11,color:"#334155",marginTop:2}}>90-day simulation with self-tuned parameters</div></div>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <span style={{fontSize:11,color:"#475569"}}>TICKER:</span>
                <select value={btTicker} onChange={function(e){setBtTicker(e.target.value);}} style={{background:"#0f172a",border:"1px solid #1e293b",color:"#f1f5f9",borderRadius:7,padding:"8px 12px",fontSize:12}}>
                  {(watchlistStocks.length>0?watchlistStocks:TICKERS.map(function(t){return{ticker:t};})).map(function(w){return<option key={w.ticker} value={w.ticker}>{w.ticker}{w.name?" - "+w.name.substring(0,20):""}</option>;})}
                </select>
              </div>
            </div>
            {!btResult?<div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:40,textAlign:"center",color:"#334155",fontSize:13}}>Loading...</div>:<BTResults r={btResult} ticker={btTicker}/>}
          </div>
        )}

        {topTab==="apex"&&tab==="autopilot"&&(
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
          </div>
        )}

        {topTab==="apex"&&tab==="ai"&&<LosersTab stocks={stocks} setModal={setModal} setTab={setTab} setQty={setQty} anthropicKey={anthropicKey} fhKey={fhKey} fmpKey={fmpKey}/>}

        {topTab==="apex"&&tab==="settings"&&(
          <div style={{animation:"fu 0.3s ease",maxWidth:560}}>
            <div style={{marginBottom:18}}><div style={{fontSize:20,fontWeight:700,color:"#f1f5f9"}}>Settings</div><div style={{fontSize:11,color:"#334155",marginTop:2}}>Alpaca integration and strategy parameters</div></div>
            <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"22px",marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:700,color:"#f1f5f9",marginBottom:4}}>Account</div>
              <div style={{fontSize:12,color:"#475569",marginBottom:14}}>Signed in as: <span style={{color:"#f1f5f9"}}>{auth.profile&&(auth.profile.email||auth.profile.display_name)}</span></div>
              <button onClick={function(){supabase.auth.signOut().finally(function(){Object.keys(localStorage).forEach(function(k){if(k.startsWith('sb-'))localStorage.removeItem(k);});window.location.href='/';});}} style={{background:"#7f1d1d",border:"none",color:"#fca5a5",borderRadius:7,padding:"9px 18px",fontSize:12,fontWeight:600,cursor:"pointer"}}>Sign Out</button>
            </div>
            <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"22px",marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <div style={{fontSize:14,fontWeight:700,color:"#f1f5f9"}}>Alpaca API Integration</div>
                <span style={{background:"#052e16",border:"1px solid #15803d",color:"#4ade80",fontSize:9,fontWeight:700,borderRadius:4,padding:"2px 7px",letterSpacing:1}}>PAPER MODE</span>
              </div>
              <div style={{fontSize:12,color:"#475569",lineHeight:1.6,marginBottom:14}}>Enter your Alpaca paper trading API keys.</div>
              <div style={{marginBottom:12}}><div style={{fontSize:10,color:"#334155",marginBottom:5}}>API KEY</div><input type="text" placeholder="PK..." value={alpaca.key} onChange={function(e){var v=e.target.value;setAlpaca(function(p){return Object.assign({},p,{key:v});});}} style={{width:"100%",background:"#0f172a",border:"1px solid #1e293b",color:"#f1f5f9",borderRadius:7,padding:"9px 13px",fontSize:12,outline:"none"}}/></div>
              <div style={{marginBottom:14}}><div style={{fontSize:10,color:"#334155",marginBottom:5}}>SECRET KEY</div><input type="password" placeholder="..." value={alpaca.secret} onChange={function(e){var v=e.target.value;setAlpaca(function(p){return Object.assign({},p,{secret:v});});}} style={{width:"100%",background:"#0f172a",border:"1px solid #1e293b",color:"#f1f5f9",borderRadius:7,padding:"9px 13px",fontSize:12,outline:"none"}}/></div>
              <button onClick={function(){notify(alpaca.key?"Alpaca configured (paper mode)":"Enter API keys first",!alpaca.key);}} style={{background:"#1d4ed8",border:"none",color:"#fff",borderRadius:7,padding:"9px 18px",fontSize:12,fontWeight:600}}>Save + Test Connection</button>
            </div>
            <div style={{background:"#0a0f1a",border:"1px solid #0f172a",borderRadius:12,padding:"22px",marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:700,color:"#f1f5f9",marginBottom:4}}>Data Sources</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                {[{label:"Twelve Data",sub:"Prices & History"},{label:"Finnhub",sub:"Analyst & Sentiment"},{label:"FMP",sub:"Fundamentals"}].map(function(s,i){
                  return(<div key={i} style={{background:"#052e16",border:"1px solid #15803d",borderRadius:7,padding:"10px 12px"}}>
                    <div style={{fontSize:11,fontWeight:700,color:"#4ade80"}}>{s.label}</div>
                    <div style={{fontSize:10,color:"#334155"}}>{s.sub}</div>
                    <div style={{fontSize:9,color:"#22c55e",marginTop:4}}>ACTIVE</div>
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
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
