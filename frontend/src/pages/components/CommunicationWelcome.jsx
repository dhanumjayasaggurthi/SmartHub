import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePerfTier, measureTier } from '../../utils/perfTier';
import { PLACEHOLDERS } from './CommunicationParts';

import aiIcon       from "/icons/JJ_Icon_AI_RGB.svg";
import calendarIcon from "/icons/JJ_Icon_Calendar_RGB.svg";
import checkIcon    from "/icons/JJ_Icon_Check_RGB.svg";

/*
 * Landing screen for /communication-center (no ?tab= yet).
 *
 * Lazy-loaded by the page, so a deep link straight into Compose, the Queue or
 * Sent history never downloads the canvas code below.
 *
 * The hero plays one shared cycle — Write → Brand → Schedule → Deliver, once
 * per message type — and draws it as either a globe or an envelope, picked
 * at random per visit. Both are decorative: no places, audiences or numbers
 * in them are claims about real sends. The real numbers live in the stat
 * column and the cards, and come from the API.
 */

const PHASES = [1300, 2400, 2300, 4600];
const HOLD = 1400;
const CYCLE = PHASES.reduce((a, b) => a + b, 0) + HOLD;

const STEPS = [
  ['Write',    'Draft it yourself, or let AI start it for you.'],
  ['Brand',    'House template, banner and colour, built in.'],
  ['Schedule', 'Now, or to the minute, in Eastern time.'],
  ['Deliver',  'Every inbox, exactly as you previewed it.'],
];

const TYPE_COPY = {
  update:      'Release notes, new features, improvements.',
  warning:     'Action required, access reviews, deadlines.',
  maintenance: 'Planned downtime and service windows.',
  custom:      'Sessions, recaps, anything else.',
};

// Only for the animation while /config is still in flight or unreachable.
// Everything a user can click uses the categories the server sent.
const FALLBACK_CATS = [
  { id: 'update', label: 'Update', color: '#eb1700', prefix: '[SmartHub Update]' },
  { id: 'warning', label: 'Warning', color: '#ff6017', prefix: '[SmartHub Warning]' },
  { id: 'maintenance', label: 'Maintenance', color: '#6e6259', prefix: '[SmartHub Maintenance]' },
  { id: 'custom', label: 'Custom', color: '#8c3bbb', prefix: '' },
];

// Where a message lands, not who it goes to — true of every send.
const CLIENTS = [
  { name: 'Outlook desktop', short: 'OD', color: '#0f68b2' },
  { name: 'Outlook mobile', short: 'OM', color: '#8c3bbb' },
  { name: 'Outlook on the web', short: 'OW', color: '#328714' },
];


const hints = (id) => PLACEHOLDERS[id] || PLACEHOLDERS.custom;
const rgba = (hex, a) => {
  const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16) || 0;
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── scoped styles ───────────────────────────────────────────────────────────
 * Injected once, every class cw- prefixed so nothing here can collide with a
 * Tailwind utility or another page's class (.brand and friends already did). */
const CSS = `
.cw{--c:#eb1700;--line:rgba(110,98,89,.16);--ease:cubic-bezier(.16,1,.3,1);--display:'JohnsonDisplay',Arial,Helvetica,sans-serif;--text:'JohnsonText',Arial,Helvetica,sans-serif;
  position:relative;min-height:100%;overflow:hidden;color:#312c2a;font-family:var(--text);
  background:radial-gradient(90% 80% at 52% 38%,#fff 0%,#faf8f5 38%,#f2eee9 72%,#ebe6e0 100%)}
.cw button{font-family:inherit;color:inherit}
.cw-ico{display:inline-block;flex:none;background:currentColor;-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat}
@keyframes cw-rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}
@keyframes cw-fade{from{opacity:0}to{opacity:1}}
@keyframes cw-halo{0%,100%{opacity:.55}25%{opacity:.75}50%{opacity:.95}75%{opacity:.75}}
@keyframes cw-ring{0%{opacity:.6;transform:scale(.82)}100%{opacity:0;transform:scale(1.7)}}
@keyframes cw-shimmer{0%{transform:translateX(-130%) skewX(-18deg)}60%,100%{transform:translateX(260%) skewX(-18deg)}}
@keyframes cw-sheen{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes cw-fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes cw-cardin{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}
@keyframes cw-float{0%,100%{transform:translateY(0) rotate(-1.2deg)}12.5%{transform:translateY(-1.8px) rotate(-.9deg)}25%{transform:translateY(-6px) rotate(-.2deg)}37.5%{transform:translateY(-10.2px) rotate(.5deg)}50%{transform:translateY(-12px) rotate(.8deg)}62.5%{transform:translateY(-10.2px) rotate(.5deg)}75%{transform:translateY(-6px) rotate(-.2deg)}87.5%{transform:translateY(-1.8px) rotate(-.9deg)}}
@keyframes cw-launch{0%{transform:none}30%{transform:translateY(8px) scale(.97)}60%{transform:translateY(-22px) scale(1.04)}100%{transform:none}}
@keyframes cw-stamp{0%{transform:translate(-50%,-50%) scale(1.9);opacity:0}60%{transform:translate(-50%,-50%) scale(.92);opacity:1}100%{transform:translate(-50%,-50%) scale(1)}}
@keyframes cw-shad{0%,100%{transform:scale(1);opacity:.9}25%{transform:scale(.91);opacity:.72}50%{transform:scale(.82);opacity:.55}75%{transform:scale(.91);opacity:.72}}
.cw-grain{position:absolute;inset:0;pointer-events:none;opacity:.5;background-image:radial-gradient(rgba(110,98,89,.12) 1px,transparent 1px);background-size:22px 22px;-webkit-mask:radial-gradient(70% 60% at 50% 40%,transparent 30%,#000 100%);mask:radial-gradient(70% 60% at 50% 40%,transparent 30%,#000 100%)}
.cw-spot{position:absolute;left:50%;top:40%;width:70vmin;height:70vmin;margin:-35vmin 0 0 -35vmin;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle,${'color-mix(in srgb,var(--c) 14%,transparent)'} 0%,${'color-mix(in srgb,var(--c) 5%,transparent)'} 38%,transparent 66%);animation:cw-halo 7s steps(84) infinite;will-change:opacity}
.cw-wrap{position:relative;min-height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:clamp(10px,1.8vh,24px);padding:clamp(14px,2.2vh,30px) clamp(20px,4vw,56px) clamp(16px,2.6vh,34px)}
.cw-top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;animation:cw-fade .8s ease both}
.cw-brand{display:flex;align-items:center;gap:16px;min-width:0}
.cw-brand img{width:104px;display:block}
.cw-brand i{width:1px;height:30px;background:rgba(175,165,155,.6)}
.cw-brand b{display:block;font-family:var(--display);font-weight:700;font-size:14px;letter-spacing:.16em;text-transform:uppercase}
.cw-brand small{display:block;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:#6e6259;margin-top:3px}
.cw-chip{display:inline-flex;align-items:center;gap:10px;padding:7px 14px;border-radius:999px;background:rgba(255,255,255,.74);border:1px solid var(--line);box-shadow:0 10px 26px -20px rgba(49,44,42,.6);
  font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:#6e6259;white-space:nowrap;max-width:100%}
.cw-chip b{font-family:var(--display);font-weight:500;letter-spacing:.02em;text-transform:none;font-size:11.5px;color:#312c2a;overflow:hidden;text-overflow:ellipsis}
.cw-chip .sep{width:1px;height:12px;background:#cbc4bc}
.cw-chip button{text-transform:none;letter-spacing:0;font-size:11.5px;color:#eb1700;text-decoration:underline;text-underline-offset:2px}
.cw-dot{position:relative;width:7px;height:7px;border-radius:50%;flex:none;background:var(--dot,#328714);box-shadow:0 0 10px var(--dot,#328714)}
.cw-dot.live::after{content:"";position:absolute;inset:0;border-radius:50%;border:1px solid var(--dot,#328714);animation:cw-ring 2.4s ease-out infinite}

.cw-stage{position:relative;display:grid;grid-template-columns:minmax(250px,.9fr) minmax(340px,1.3fr) minmax(170px,.55fr);align-items:center;gap:clamp(16px,3vw,48px);min-height:0}
.cw-flow{animation:cw-rise .9s var(--ease) .1s both}
.cw-eyebrow{display:flex;align-items:center;gap:10px;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#6e6259;margin-bottom:clamp(10px,2vh,22px)}
.cw-step{position:relative;display:grid;grid-template-columns:34px 1fr;align-items:baseline;column-gap:12px;padding:clamp(5px,1vh,10px) 0;color:#cbc4bc;transition:color .5s}
.cw-step .no{font-size:10px;letter-spacing:.16em;font-variant-numeric:tabular-nums}
.cw-step b{font-family:var(--display);font-weight:300;font-size:clamp(28px,1.9vw + 1.6vh,52px);line-height:1;letter-spacing:-.035em}
.cw-step small{grid-column:2;font-size:12px;font-weight:300;color:#81766f;max-height:0;opacity:0;overflow:hidden;transition:max-height .5s var(--ease),opacity .4s,margin .5s}
.cw-step .bar{position:absolute;left:0;bottom:0;height:1px;width:100%;background:rgba(110,98,89,.14)}
.cw-step .bar i{display:block;height:100%;width:100%;background:var(--c);transform:scaleX(0);transform-origin:0 50%}
.cw-step.on{color:#312c2a}
.cw-step.on .no{color:var(--c)}
.cw-step.on small{max-height:40px;opacity:1;margin-top:6px}
.cw-step.on .bar i{animation:cw-fill var(--d,2s) linear forwards}
.cw-step.done{color:#81766f}
.cw-step.done .bar i{transform:none;background:rgba(110,98,89,.35)}
.cw-ctas{display:flex;gap:12px;align-items:center;margin-top:clamp(14px,3vh,32px);flex-wrap:wrap;animation:cw-rise .9s var(--ease) .35s both}
.cw-cta{position:relative;overflow:hidden;display:inline-flex;align-items:center;gap:12px;padding:15px 24px;border-radius:13px;background:#eb1700;color:#fff!important;font-family:var(--display)!important;font-weight:700;font-size:14px;letter-spacing:.04em;
  border:1px solid rgba(235,23,0,.34);box-shadow:0 20px 40px -18px rgba(235,23,0,.6);transition:transform .4s var(--ease)}
.cw-cta:hover{transform:translateY(-3px)}
.cw-cta:focus-visible,.cw-ghost:focus-visible,.cw-card:focus-visible,.cw-stat:focus-visible{outline:2px solid #0f68b2;outline-offset:3px}
.cw-cta::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:cw-shimmer 3.6s ease-in-out 1.4s infinite;will-change:transform}
.cw-cta .arr{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.2);transition:transform .3s var(--ease)}
.cw-cta:hover .arr{transform:translateX(3px)}
.cw-ghost{display:inline-flex;align-items:center;gap:10px;padding:14px 20px;border-radius:13px;background:rgba(255,255,255,.78);border:1px solid var(--line);font-family:var(--display)!important;font-weight:500;font-size:14px;
  box-shadow:0 14px 30px -24px rgba(49,44,42,.8);transition:transform .28s var(--ease),border-color .28s}
.cw-ghost:hover{transform:translateY(-3px);border-color:rgba(140,59,187,.45)}
.cw-kbd{display:inline-flex;align-items:center;height:22px;padding:0 7px;border-radius:6px;border:1px solid #e8e6e3;background:linear-gradient(#fff,#f7f5f3);font-size:10.5px;color:#6e6259;box-shadow:0 2px 0 #e8e6e3}
.cw-hint{font-size:11px;color:#81766f;display:flex;align-items:center;gap:6px}

.cw-scene{position:relative;height:min(58vh,500px);min-height:340px;animation:cw-fade 1.2s ease .15s both}
.cw-hv{position:absolute;inset:0 0 44px}
.cw-globe{position:absolute;inset:0;width:100%;height:100%}
.cw-orb{position:absolute;border-radius:50%;pointer-events:none;
  background:radial-gradient(circle at 32% 28%,#fff 0%,#f6f2ed 55%,#f1ece6 100%);
  box-shadow:0 0 0 1px rgba(110,98,89,.14),0 0 70px 18px ${'color-mix(in srgb,var(--c) 9%,transparent)'}}
.cw-ticker{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);display:flex;gap:16px;width:min(440px,92%)}
.cw-tk{flex:1;min-width:0;font-size:9.5px;letter-spacing:.18em;text-transform:uppercase;color:#a39992;transition:color .4s}
.cw-tk span{display:flex;align-items:center;gap:7px;margin-bottom:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-tk span::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--k);opacity:.35;transition:opacity .4s,box-shadow .4s}
.cw-tk i{display:block;height:2px;border-radius:2px;background:rgba(110,98,89,.16);overflow:hidden}
.cw-tk em{display:block;height:100%;width:100%;background:var(--k);transform:scaleX(0);transform-origin:0 50%}
.cw-tk.on{color:#312c2a}
.cw-tk.on span::before{opacity:1;box-shadow:0 0 8px var(--k)}
.cw-tk.on em{animation:cw-fill ${CYCLE}ms linear forwards}
.cw-tk.done em{transform:none;background:rgba(110,98,89,.3)}

.cw-env-hv{display:grid;grid-template-columns:1.05fr .95fr;align-items:center;gap:clamp(48px,6vw,110px)}
.cw-wires{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.cw-wires .w{fill:none;stroke:rgba(110,98,89,.22);stroke-width:1;stroke-dasharray:2 5}
.cw-wires .wa{fill:none;stroke:var(--c);stroke-width:1.6;stroke-linecap:round;opacity:.75}
.cw-wires .node{fill:#fff;stroke:var(--c);stroke-width:1.5}
.cw-wires .pk rect{fill:#fff;stroke:var(--c);stroke-width:1.2}
.cw-wires .pk path{fill:none;stroke:var(--c);stroke-width:1.2}
.cw-env-col{position:relative;z-index:2;display:flex;justify-content:center}
.cw-tilt{position:relative;transition:transform .6s cubic-bezier(.22,1,.36,1);will-change:transform}
.cw-env{position:relative;width:clamp(230px,17vw,320px);aspect-ratio:1.55;perspective:900px;animation:cw-float 6s steps(180) infinite;will-change:transform}
.cw-env.launch{animation:cw-launch .7s var(--ease)}
.cw-e-back{position:absolute;inset:0;border-radius:12px;background:linear-gradient(180deg,#e7e0d7,#f3eee7);box-shadow:0 30px 60px -28px rgba(49,44,42,.55),inset 0 0 0 1px rgba(110,98,89,.1)}
.cw-slot{position:absolute;left:0;right:0;bottom:0;top:-150%;overflow:hidden;z-index:2;pointer-events:none}
.cw-letter{position:absolute;left:5%;right:5%;bottom:2%;height:36%;background:#fff;border-radius:7px;padding:6% 7% 0;overflow:hidden;box-shadow:0 14px 34px -14px rgba(49,44,42,.4);transform:translateY(30%);transition:transform 1.05s var(--ease)}
.cw-letter.up{transform:translateY(-82%)}
.cw-letter img{width:34%;display:block}
.cw-letter .bn{margin-top:6%;padding:5% 6% 4.5%;border-radius:4px;background:var(--c);color:#fff;transition:background .6s}
.cw-letter .bn b{display:block;font-family:var(--display);font-weight:400;font-size:clamp(14px,1.35vw,22px);line-height:1.05}
.cw-letter .bn i{display:block;font-family:var(--display);font-size:clamp(9px,.75vw,12px);margin-top:3px}
.cw-letter .hl{margin:6% 0 4%;font-family:var(--display);font-size:clamp(11px,.95vw,15px);color:var(--c);transition:color .6s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-letter .ln{height:5px;border-radius:3px;background:#e8e6e3;margin:0 0 6px}
.cw-e-front{position:absolute;inset:0;z-index:3}
.cw-e-front::before{content:"";position:absolute;inset:-2px 0 0;border-radius:12px;background:rgba(49,44,42,.06);clip-path:polygon(0 0,50% 66%,100% 0,100% 100%,0 100%)}
.cw-e-front i{position:absolute;inset:0;border-radius:12px;background:linear-gradient(165deg,#fbf9f6 0%,#f1ebe3 100%);clip-path:polygon(0 0,50% 66%,100% 0,100% 100%,0 100%)}
.cw-e-front i::after{content:"";position:absolute;left:7%;bottom:12%;width:30%;height:6px;border-radius:3px;background:rgba(110,98,89,.12);box-shadow:0 12px 0 -1px rgba(110,98,89,.08)}
.cw-flap{position:absolute;left:0;right:0;top:0;height:66%;z-index:4;transform-origin:50% 0;transition:transform .8s var(--ease),z-index 0s .45s;will-change:transform}
.cw-flap::before{content:"";position:absolute;inset:0 0 -3px;background:rgba(49,44,42,.08);clip-path:polygon(0 0,100% 0,50% 100%)}
.cw-flap i{position:absolute;inset:0;border-radius:12px 12px 0 0;background:linear-gradient(180deg,#ece5dc,#e0d7cc);clip-path:polygon(0 0,100% 0,50% 100%)}
.cw-env.open .cw-flap{transform:rotateX(180deg);z-index:1;transition:transform .8s var(--ease),z-index 0s .3s}
.cw-seal{position:absolute;left:50%;top:66%;z-index:5;width:15%;aspect-ratio:1;transform:translate(-50%,-50%);border-radius:50%;display:grid;place-items:center;color:#fff;font:700 clamp(10px,.95vw,15px) var(--display);
  background:radial-gradient(circle at 35% 30%,${'color-mix(in srgb,var(--c) 55%,#fff)'},var(--c) 55%,${'color-mix(in srgb,var(--c) 70%,#000)'});box-shadow:0 8px 16px -6px rgba(49,44,42,.4),inset 0 0 0 3px rgba(255,255,255,.18);transition:opacity .25s,transform .45s var(--ease)}
.cw-env.open .cw-seal{opacity:0;transform:translate(-50%,-50%) scale(.3)}
.cw-seal.stamp{animation:cw-stamp .55s var(--ease)}
.cw-e-shadow{position:absolute;left:50%;top:calc(50% + 4px);width:34%;height:22px;margin-left:-17%;border-radius:50%;background:radial-gradient(closest-side,rgba(49,44,42,.22),rgba(49,44,42,.08) 55%,transparent);animation:cw-shad 6s steps(180) infinite;will-change:transform,opacity}
.cw-inboxes{position:relative;z-index:2;display:flex;flex-direction:column;gap:14px;max-width:260px;width:100%;justify-self:end}
.cw-ibx{display:grid;grid-template-columns:36px 1fr auto;column-gap:11px;row-gap:3px;align-items:center;padding:12px 14px 13px;border-radius:15px;background:rgba(255,255,255,.9);border:1px solid var(--line);
  box-shadow:0 16px 34px -26px rgba(49,44,42,.7);transition:border-color .4s,box-shadow .4s,transform .4s var(--ease);animation:cw-rise .7s var(--ease) both}
.cw-ibx .av{grid-row:1/3;width:36px;height:36px;border-radius:11px;display:grid;place-items:center;color:#fff;font:700 11px var(--display)}
.cw-ibx b{font-family:var(--display);font-weight:500;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-ibx .n{grid-column:2;font-size:11px;color:#81766f}
.cw-ibx .ok{grid-column:3;grid-row:1/3;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:#f1efed;color:#cbc4bc;font-size:11px;transition:all .4s var(--ease)}
.cw-ibx .pb{grid-column:1/-1;height:3px;margin-top:9px;border-radius:2px;background:#f1efed;overflow:hidden}
.cw-ibx .pb i{display:block;height:100%;width:100%;border-radius:2px;background:var(--c);transform:scaleX(0);transform-origin:0 50%;transition:transform .6s var(--ease)}
.cw-ibx.done{border-color:${'color-mix(in srgb,var(--c) 35%,transparent)'}}
.cw-ibx.done .ok{background:#328714;color:#fff}

.cw-kpis{display:flex;flex-direction:column;gap:clamp(10px,2vh,22px);animation:cw-rise .9s var(--ease) .45s both}
.cw-stat{display:block;text-align:left;padding:4px 0 4px 14px;border-left:1px solid rgba(110,98,89,.2);border-radius:0 8px 8px 0;transition:border-color .3s,background .3s}
.cw-stat:hover{border-left-color:var(--c);background:rgba(255,255,255,.5)}
.cw-stat b{display:flex;align-items:center;gap:8px;font-family:var(--display);font-weight:300;font-size:clamp(26px,1.3vw + 1.4vh,40px);letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.cw-stat b .go{font-size:14px;color:#eb1700;opacity:0;transform:translateX(-4px);transition:all .3s var(--ease)}
.cw-stat:hover b .go{opacity:1;transform:none}
.cw-stat > span{display:block;margin-top:6px;font-size:9.5px;letter-spacing:.2em;text-transform:uppercase;color:#6e6259}
.cw-skel,.cw-skelcard{position:relative;overflow:hidden;background:#ece8e3}
.cw-skel::after,.cw-skelcard::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);animation:cw-sheen 1.4s linear infinite;will-change:transform}
.cw-skel{display:inline-block;width:2.2em;height:.8em;border-radius:6px}

.cw-pick{display:grid;grid-template-columns:1.35fr 1fr;gap:clamp(14px,2vw,28px);animation:cw-rise 1s var(--ease) .6s both}
.cw-ph{display:flex;align-items:center;gap:16px;margin-bottom:clamp(10px,1.5vh,16px);font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#6e6259}
.cw-ph::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(175,165,155,.5),rgba(175,165,155,0))}
.cw-types{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.cw-card{position:relative;text-align:left;border-radius:18px;border:1px solid var(--line);background:linear-gradient(160deg,rgba(255,255,255,.95),rgba(250,249,247,.86));
  box-shadow:0 18px 38px -30px rgba(49,44,42,.75);transition:transform .45s var(--ease),border-color .32s}
.cw-card::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;box-shadow:0 28px 52px -26px ${'color-mix(in srgb,var(--k) 40%,transparent)'};opacity:0;transition:opacity .45s var(--ease)}
.cw-card:hover{transform:translateY(-6px);border-color:${'color-mix(in srgb,var(--k) 55%,transparent)'}}
.cw-card:hover::after{opacity:1}
.cw-type{display:flex;flex-direction:column;padding:0 0 14px;animation:cw-cardin .6s var(--ease) both}
.cw-type .mini{position:relative;height:58px;margin:10px 10px 12px;border-radius:10px;background:#fff;border:1px solid #e8e6e3;overflow:hidden}
.cw-type .mini .bn{height:30px;margin-top:-6px;padding:11px 8px 5px;background:var(--k);color:#fff;font-family:var(--display);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:transform .45s var(--ease)}
.cw-type .mini i{display:block;height:4px;border-radius:2px;background:#e8e6e3;margin:6px 8px 0}
.cw-type .mini i+i{width:60%}
.cw-type:hover .mini .bn{transform:translateY(6px)}
.cw-type .nm{padding:0 14px;font-family:var(--display);font-weight:500;font-size:17px;letter-spacing:-.015em;display:flex;align-items:center;gap:8px}
.cw-type .nm::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--k);box-shadow:0 0 10px var(--k)}
.cw-type .pf{padding:4px 14px 0;font-size:11px;color:#81766f;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-type .ds{padding:6px 14px 0;font-size:12px;font-weight:300;color:#6e6259;line-height:1.45}
.cw-works{display:flex;flex-direction:column;gap:8px}
.cw-work{display:flex;align-items:center;gap:14px;padding:12px 16px;width:100%}
.cw-work .ic{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:${'color-mix(in srgb,var(--k) 9%,transparent)'};color:var(--k)}
.cw-work .tx{flex:1;min-width:0}
.cw-work .tx b{display:block;font-family:var(--display);font-weight:500;font-size:15.5px}
.cw-work .tx span{display:block;font-size:11.5px;color:#81766f;font-weight:300;margin-top:2px}
.cw-work .badge{font-family:var(--display);font-weight:500;font-size:20px;font-variant-numeric:tabular-nums;color:var(--k)}
.cw-work .go{color:#eb1700;opacity:.6;transition:transform .3s var(--ease),opacity .3s}
.cw-work:hover .go{transform:translateX(4px);opacity:1}
.cw-skelcard{height:150px;border-radius:18px;background:#f1ede8}


@media (max-width:1180px){.cw-stage{grid-template-columns:1fr 1.2fr}.cw-kpis{grid-column:1/-1;flex-direction:row;flex-wrap:wrap;gap:28px}.cw-pick{grid-template-columns:1fr}}
@media (max-width:760px){.cw-stage{grid-template-columns:1fr}.cw-scene{height:340px}.cw-types{grid-template-columns:repeat(2,minmax(0,1fr))}.cw-env-hv{grid-template-columns:1fr;gap:20px}.cw-inboxes{display:none}.cw-wires{display:none}}
`;

const useStyles = () => {
  useEffect(() => {
    if (document.getElementById('cw-styles')) return;
    const tag = document.createElement('style');
    tag.id = 'cw-styles';
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }, []);
};

const MaskIcon = ({ src, size = 16, style }) => (
  <i className="cw-ico" style={{ '--i': `url("${src}")`, width: size, height: size, ...style }} aria-hidden="true" />
);

/* Counts up once a real number arrives; a skeleton until then, a dash if
   the number could not be fetched. */
const Stat = ({ value }) => {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (typeof value !== 'number') return undefined;
    let raf;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 1100);
      setShown(Math.round(value * (1 - (1 - p) ** 4)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  if (value === undefined) return <span className="cw-skel" aria-label="Loading" />;
  if (value === null) return <span title="Could not be loaded">n/a</span>;
  return <span>{shown.toLocaleString()}</span>;
};

/* ─── globe ───────────────────────────────────────────────────────────────── */

const rad = (d) => (d * Math.PI) / 180;
const vec = (lat, lon) => [Math.cos(rad(lat)) * Math.sin(rad(lon)), Math.sin(rad(lat)), Math.cos(rad(lat)) * Math.cos(rad(lon))];

// Rough continent outlines (lon, lat). Only dots that land inside are drawn.
const LAND = [
  [[-168,65],[-140,70],[-95,72],[-80,63],[-60,55],[-55,47],[-70,42],[-76,35],[-81,25],[-90,29],[-97,26],[-97,18],[-88,15],[-83,9],[-78,8],[-90,14],[-105,20],[-112,30],[-118,34],[-124,40],[-125,48],[-135,58],[-150,60],[-165,60]],
  [[-55,60],[-45,60],[-20,70],[-20,80],[-60,82],[-70,76],[-55,68]],
  [[-78,8],[-60,10],[-50,0],[-35,-6],[-40,-22],[-48,-28],[-58,-38],[-65,-55],[-72,-50],[-73,-38],[-71,-18],[-81,-5],[-78,2]],
  [[-10,36],[-9,44],[-2,44],[-5,48],[2,51],[8,54],[10,58],[5,62],[15,69],[28,71],[40,67],[45,55],[40,45],[28,41],[25,36],[15,38],[10,44],[3,43]],
  [[-17,15],[-17,21],[-10,30],[-5,36],[10,37],[20,32],[32,31],[35,28],[43,12],[51,12],[40,-2],[40,-15],[35,-25],[20,-35],[17,-30],[12,-17],[9,-1],[5,5],[-8,4],[-14,10]],
  [[28,41],[40,45],[45,55],[40,67],[60,70],[80,73],[100,77],[140,72],[170,68],[180,65],[160,60],[143,52],[140,45],[130,42],[122,40],[120,30],[110,20],[108,12],[105,9],[100,13],[98,8],[100,2],[104,1],[95,16],[92,22],[80,15],[77,8],[72,20],[67,25],[57,25],[52,27],[48,30],[56,24],[59,22],[52,16],[43,12],[35,28],[36,36]],
  [[114,-22],[122,-18],[130,-12],[137,-12],[142,-11],[146,-19],[153,-25],[150,-37],[140,-38],[132,-32],[115,-34]],
  [[130,31],[135,34],[141,36],[142,41],[141,45],[139,38],[132,34]],
  [[-5,50],[1,51],[2,53],[-1,55],[-3,58],[-6,57],[-5,53]],
  [[95,5],[105,-6],[115,-8],[125,-9],[130,-3],[120,1],[110,1],[100,2]],
  [[43,-12],[50,-15],[49,-25],[44,-24]],
];
const onLand = (lon, lat) => LAND.some((poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
});
let landDots = null;   // built on first use, then shared by every mount
const getLandDots = () => {
  if (landDots) return landDots;
  const N = 5200; landDots = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N; const r = Math.sqrt(1 - y * y); const a = i * 2.39996;
    const v = [Math.cos(a) * r, y, Math.sin(a) * r];
    if (onLand((Math.atan2(v[0], v[2]) * 180) / Math.PI, (Math.asin(y) * 180) / Math.PI)) landDots.push(v);
  }
  return landDots;
};
const HUB = vec(40.57, -74.63);
// Decorative end points, deliberately unlabelled — not a list of sites.
const ENDS = [[19.4,-99.1],[-23.5,-46.6],[51.6,-0.7],[51.3,4.9],[-33.9,18.4],[1.3,103.8],[13,77.6],[31.2,121.5],[35.7,139.7],[-33.9,151.2]].map(([a, b]) => vec(a, b));

/*
 * The globe, tuned for Cloud PCs with no GPU, where every pixel is painted by
 * the CPU:
 *   - the sphere and its glow are CSS behind the canvas, painted once, so a
 *     frame only redraws dots and arcs;
 *   - dot projection runs once per frame into typed arrays, then three batched
 *     fills of tiny rects (a rect is far cheaper to rasterise than an arc);
 *   - all motion is driven by elapsed time, not frame count, so a dropped
 *     frame never makes it stutter or slow down - it just lands where it
 *     should be;
 *   - it watches its own cost and steps down resolution and dot density on a
 *     machine that can't keep up. It never stops animating.
 */
const LEVELS = [
  { scale: 2, stride: 1, gap: 16 },     // GPU machines: 60 fps, retina
  { scale: 1, stride: 1, gap: 33 },     // 30 fps at 1x
  { scale: 0.8, stride: 2, gap: 33 },   // fewer dots, 80% resolution
  { scale: 0.66, stride: 3, gap: 40 },  // floor: still moving, still smooth
];
const START_LEVEL = { full: 0, lite: 1, min: 2 };

const Globe = ({ color, phase, phaseAt, tier }) => {
  const canvas = useRef(null);
  const orb = useRef(null);
  const live = useRef({});
  live.current = { color, phase, phaseAt };

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return undefined;
    const ctx = cv.getContext('2d');
    const all = getLandDots();
    let level = START_LEVEL[tier] ?? 1;
    let dots = []; let xs; let ys; let zs;
    const pickDots = () => {
      const { stride } = LEVELS[level];
      dots = stride === 1 ? all : all.filter((_, i) => i % stride === 0);
      xs = new Float32Array(dots.length); ys = new Float32Array(dots.length); zs = new Float32Array(dots.length);
    };
    pickDots();

    let w = 0; let h = 0; let raf = 0; let last = 0; let visible = true;
    let tx = 0; let ty = 0; let sx = 0; let sy = 0;        // pointer target / smoothed
    let cost = 0; let slow = 0;
    const t0 = performance.now();
    const hits = ENDS.map(() => 0);
    let lastPhase = -1;
    let scale = 1;

    const fit = () => {
      w = cv.clientWidth; h = cv.clientHeight;
      if (!w || !h) return;
      const L = LEVELS[level];
      scale = Math.min(L.scale, window.devicePixelRatio || 1);
      cv.width = Math.round(w * scale); cv.height = Math.round(h * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const R = Math.min(w, h) * 0.4;
      if (orb.current) {
        Object.assign(orb.current.style, {
          left: `${w * 0.54 - R}px`, top: `${h * 0.53 - R}px`, width: `${R * 2}px`, height: `${R * 2}px`,
        });
      }
    };
    const ro = new ResizeObserver(fit); ro.observe(cv); fit();
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }); io.observe(cv);
    const onMove = (e) => { tx = e.clientX / window.innerWidth - 0.5; ty = e.clientY / window.innerHeight - 0.5; };
    window.addEventListener('pointermove', onMove, { passive: true });

    // Rotation for this frame, shared by every projection in it.
    let cr = 1; let sr = 0; let ct = 1; let st = 0;
    const proj = (v, R, cx, cy, k = 1) => {
      const x = v[0] * cr + v[2] * sr; const z = -v[0] * sr + v[2] * cr;
      const y = v[1] * ct - z * st; const z2 = v[1] * st + z * ct;
      const px = x * k; const py = y * k;
      // Hidden only when behind the globe AND inside its outline - a lifted
      // arc rising over the edge is still in view.
      return { x: cx + px * R, y: cy - py * R, z: z2, vis: z2 >= 0 || px * px + py * py > 1 };
    };
    const arcPt = (b, t, R, cx, cy) => {
      const a = HUB; const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
      const om = Math.acos(d); const so = Math.sin(om) || 1;
      const s1 = Math.sin((1 - t) * om) / so; const s2 = Math.sin(t * om) / so;
      return proj([a[0] * s1 + b[0] * s2, a[1] * s1 + b[1] * s2, a[2] * s1 + b[2] * s2], R, cx, cy, 1 + Math.sin(Math.PI * t) * (0.04 + om * 0.035));
    };

    const draw = (t, dt) => {
      const { color: c, phase: ph, phaseAt: at } = live.current;
      if (ph !== lastPhase) { if (ph === 0) hits.fill(0); lastPhase = ph; }
      const el = t - at;
      // Pointer follows like a weight on water: eased toward, never snapped.
      const ease = 1 - Math.exp(-dt / 220);
      sx += (tx - sx) * ease; sy += (ty - sy) * ease;
      const rot = rad(70) + (t - t0) * 0.00005 + sx * 0.6;
      const tl = 0.32 + sy * 0.25;
      cr = Math.cos(rot); sr = Math.sin(rot); ct = Math.cos(tl); st = Math.sin(tl);

      const R = Math.min(w, h) * 0.4; const cx = w * 0.54; const cy = h * 0.53;
      ctx.clearRect(0, 0, w, h);

      // dots: project once, fill in three depth buckets
      for (let i = 0; i < dots.length; i++) {
        const v = dots[i];
        const x = v[0] * cr + v[2] * sr; const z = -v[0] * sr + v[2] * cr;
        xs[i] = cx + x * R; ys[i] = cy - (v[1] * ct - z * st) * R; zs[i] = v[1] * st + z * ct;
      }
      const size = level >= 2 ? 2.6 : 2.2; const half = size / 2;
      for (const [lo, hi, a] of [[0, 0.35, 0.22], [0.35, 0.7, 0.4], [0.7, 1.01, 0.6]]) {
        ctx.fillStyle = `rgba(110,98,89,${a})`; ctx.beginPath();
        for (let i = 0; i < dots.length; i++) {
          const z = zs[i];
          if (z >= lo && z < hi) ctx.rect(xs[i] - half, ys[i] - half, size, size);
        }
        ctx.fill();
      }

      const steps = level >= 2 ? 48 : 80;
      const drawn = ph >= 1 ? Math.min(1, (ph === 1 ? el : 1e9) / 1500) : 0;
      ctx.lineCap = 'round';
      ENDS.forEach((b, i) => {
        const prog = Math.max(0, Math.min(1, drawn * 1.6 - i * 0.06));
        if (prog > 0) {
          ctx.strokeStyle = rgba(c, 0.55); ctx.lineWidth = 1.3; ctx.beginPath();
          let pen = false;
          for (let k = 0; k <= steps * prog; k++) {
            const q = arcPt(b, k / steps, R, cx, cy);
            if (!q.vis) { pen = false; continue; }
            if (pen) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
            pen = true;
          }
          ctx.stroke();
        }
        if (ph === 3) {
          const pt = Math.max(0, Math.min(1, (el - 300 - i * 170) / 1300));
          if (pt > 0 && pt < 1) {
            const head = arcPt(b, pt, R, cx, cy);
            if (head.vis) {
              // A soft comet: wide faint trail, narrow bright core, white head.
              ctx.beginPath();
              for (let k = 0; k <= 6; k++) {
                const q = arcPt(b, Math.max(0, pt - 0.12 + (0.12 * k) / 6), R, cx, cy);
                if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
              }
              ctx.strokeStyle = rgba(c, 0.22); ctx.lineWidth = 5; ctx.stroke();
              ctx.strokeStyle = rgba(c, 0.85); ctx.lineWidth = 2; ctx.stroke();
              ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(head.x, head.y, 3, 0, 6.283); ctx.fill();
              ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.stroke();
            }
          }
          if (pt >= 1 && !hits[i]) hits[i] = t;
        }
      });
      ctx.lineCap = 'butt';

      ENDS.forEach((b, i) => {
        const q = proj(b, R, cx, cy);
        if (q.z < -0.05) return;
        const got = hits[i] > 0;
        if (got) {
          const k = (t - hits[i]) / 1100;
          if (k < 1) { ctx.strokeStyle = rgba(c, (1 - k) * 0.8); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(q.x, q.y, 4 + k * 16, 0, 6.283); ctx.stroke(); }
        }
        ctx.globalAlpha = Math.min(1, 0.35 + q.z);
        ctx.fillStyle = got ? c : '#fff'; ctx.strokeStyle = got ? '#fff' : 'rgba(110,98,89,.6)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(q.x, q.y, got ? 4.2 : 3.2, 0, 6.283); ctx.fill(); ctx.stroke();
        ctx.globalAlpha = 1;
      });

      const hp = proj(HUB, R, cx, cy);
      if (hp.z > -0.1) {
        const pulse = (Math.sin(t / 400) + 1) / 2;
        ctx.fillStyle = rgba(c, 0.15 + pulse * 0.1); ctx.beginPath(); ctx.arc(hp.x, hp.y, 13 + pulse * 3, 0, 6.283); ctx.fill();
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(hp.x, hp.y, 6, 0, 6.283); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
        if (ph === 2) {
          const k = Math.min(1, el / 1600);
          ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(hp.x, hp.y, 20, -Math.PI / 2, -Math.PI / 2 + k * 6.283); ctx.stroke();
        }
      }
    };

    const loop = (t) => {
      raf = requestAnimationFrame(loop);
      const { gap } = LEVELS[level];
      if (!visible || document.hidden || !w || t - last < gap - 2) return;
      const dt = last ? Math.min(100, t - last) : gap;
      last = t;
      const start = performance.now();
      draw(t, dt);
      // Self-tuning: if a frame keeps eating most of its budget, drop a level.
      cost = cost * 0.9 + (performance.now() - start) * 0.1;
      slow = cost > gap * 0.5 ? slow + 1 : 0;
      if (slow > 30 && level < LEVELS.length - 1) {
        level += 1; slow = 0; cost = 0;
        pickDots(); fit();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); window.removeEventListener('pointermove', onMove); };
  }, [tier]);

  return (
    <>
      <div ref={orb} className="cw-orb" aria-hidden="true" />
      <canvas ref={canvas} className="cw-globe" aria-hidden="true" />
    </>
  );
};

/* ─── envelope ────────────────────────────────────────────────────────────── */

const NS = 'http://www.w3.org/2000/svg';

const Envelope = ({ cat, phase, cycle, logo }) => {
  const host = useRef(null);
  const envRef = useRef(null);
  const svg = useRef(null);
  const cards = useRef([]);
  const wires = useRef([]);
  const sealRef = useRef(null);
  const tiltRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [progress, setProgress] = useState([0, 0, 0]);
  const timers = useRef([]);
  const later = (fn, ms) => { timers.current.push(setTimeout(fn, ms)); };

  const layout = useCallback(() => {
    const s = host.current?.getBoundingClientRect(); const e = envRef.current?.getBoundingClientRect();
    const root = svg.current;
    if (!s || !e || !root || !s.width) return;
    root.setAttribute('viewBox', `0 0 ${s.width} ${s.height}`);
    root.replaceChildren();
    const x0 = e.right - s.left - 6; const y0 = e.top - s.top + e.height * 0.55;
    const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); root.append(n); return n; };
    wires.current = cards.current.filter(Boolean).map((c) => {
      const r = c.getBoundingClientRect(); const x1 = r.left - s.left - 4; const y1 = r.top - s.top + r.height / 2; const mx = (x0 + x1) / 2;
      const d = `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
      mk('path', { d, class: 'w' });
      const act = mk('path', { d, class: 'wa' });
      mk('circle', { cx: x1, cy: y1, r: 3.5, class: 'node' });
      const len = act.getTotalLength();
      act.style.strokeDasharray = len; act.style.strokeDashoffset = len;
      return { act, len };
    });
    mk('circle', { cx: x0, cy: y0, r: 4, class: 'node' });
  }, []);

  useEffect(() => {
    const ro = new ResizeObserver(layout);
    if (host.current) ro.observe(host.current);
    const t = setTimeout(layout, 900);   // after the cards have risen into place
    // Pointer events can arrive several times a frame; write the tilt once
    // per frame and let the CSS transition ease it in.
    let queued = 0; let px = 0; let py = 0;
    const apply = () => {
      queued = 0;
      if (tiltRef.current) tiltRef.current.style.transform = `rotateY(${px * 18}deg) rotateX(${-py * 12}deg)`;
    };
    const onMove = (e) => {
      px = e.clientX / window.innerWidth - 0.5; py = e.clientY / window.innerHeight - 0.5;
      if (!queued) queued = requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => { ro.disconnect(); clearTimeout(t); cancelAnimationFrame(queued); window.removeEventListener('pointermove', onMove); };
  }, [layout]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const packet = (w, dur) => new Promise((done) => {
    const root = svg.current;
    if (!root || !w.act.isConnected) { done(); return; }
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'pk');
    g.innerHTML = '<rect x="-7" y="-5" width="14" height="10" rx="1.5"/><path d="M-7,-5 L0,1 L7,-5"/>';
    root.append(g);
    const t0 = performance.now();
    const tick = (t) => {
      if (!g.isConnected) { done(); return; }
      const p = Math.min(1, (t - t0) / dur); const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
      const pt = w.act.getPointAtLength(e * w.len);
      g.setAttribute('transform', `translate(${pt.x},${pt.y}) scale(${0.7 + Math.sin(p * Math.PI) * 0.45})`);
      g.style.opacity = p < 0.08 ? p / 0.08 : p > 0.92 ? (1 - p) / 0.08 : 1;
      if (p < 1) requestAnimationFrame(tick); else { g.remove(); done(); }
    };
    requestAnimationFrame(tick);
  });

  useEffect(() => {
    timers.current.forEach(clearTimeout); timers.current = [];
    if (phase === 0) {
      setUp(false); setProgress([0, 0, 0]);
      wires.current.forEach((w) => { w.act.style.transition = 'none'; w.act.style.strokeDashoffset = w.len; });
      setOpen(true);
    }
    if (phase === 1) setUp(true);
    if (phase === 2) {
      setUp(false);
      later(() => setOpen(false), 900);
      later(() => { const s = sealRef.current; if (s) { s.classList.remove('stamp'); void s.offsetWidth; s.classList.add('stamp'); } }, 1450);
    }
    if (phase === 3) {
      const env = envRef.current;
      if (env) { env.classList.add('launch'); later(() => env.classList.remove('launch'), 700); }
      wires.current.forEach((w, k) => {
        later(() => {
          w.act.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.65,0,.35,1)';
          w.act.style.strokeDashoffset = 0;
          [0, 1, 2].forEach((j) => later(() => packet(w, 1100).then(() => {
            setProgress((cur) => cur.map((v, i) => (i === k ? Math.max(v, (j + 1) / 3) : v)));
          }), j * 200));
        }, k * 260);
      });
    }
  }, [phase, cycle]);

  const h = hints(cat.id);
  return (
    <div ref={host} className="cw-hv cw-env-hv">
      <svg ref={svg} className="cw-wires" aria-hidden="true" />
      <div className="cw-env-col">
        <div className="cw-e-shadow" />
        <div ref={tiltRef} className="cw-tilt">
          <div ref={envRef} className={`cw-env${open ? ' open' : ''}`}>
            <div className="cw-e-back" />
            <div className="cw-slot">
              <div className={`cw-letter${up ? ' up' : ''}`}>
                <img src={logo} alt="" />
                <div className="bn"><b>{h.bannerTitle}</b><i>{h.bannerSubtitle}</i></div>
                <div className="hl">{h.headline}</div>
                <div className="ln" /><div className="ln" style={{ width: '86%' }} /><div className="ln" style={{ width: '64%' }} />
              </div>
            </div>
            <div className="cw-e-front"><i /></div>
            <div className="cw-flap"><i /></div>
            <div ref={sealRef} className="cw-seal">SH</div>
          </div>
        </div>
      </div>
      <div className="cw-inboxes" aria-hidden="true">
        {CLIENTS.map((c, i) => {
          const p = progress[i];
          return (
            <div key={c.name} ref={(el) => { cards.current[i] = el; }}
                 className={`cw-ibx${p >= 1 ? ' done' : ''}`} style={{ animationDelay: `${0.5 + i * 0.1}s` }}>
              <span className="av" style={{ background: c.color }}>{c.short}</span>
              <b>{c.name}</b>
              <span className="ok">✓</span>
              <span className="n">{p >= 1 ? 'Delivered' : p > 0 ? 'Delivering…' : 'Waiting'}</span>
              <span className="pb"><i style={{ transform: `scaleX(${p})` }} /></span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ─── page ────────────────────────────────────────────────────────────────── */

export default function CommunicationWelcome({
  config, configState, onRetryConfig, categories, stats, aiAvailable, onOpen,
}) {
  useStyles();
  const tier = usePerfTier();
  const [hero] = useState(() => (Math.random() < 0.5 ? 'globe' : 'envelope'));
  const [typeIndex, setTypeIndex] = useState(0);
  const [phase, setPhase] = useState(-1);
  const [phaseAt, setPhaseAt] = useState(0);
  const [cycle, setCycle] = useState(0);
  const rootRef = useRef(null);

  const cats = categories.length ? categories : FALLBACK_CATS;
  const cat = cats[typeIndex % cats.length];

  useEffect(() => measureTier(5), []);

  // The cycle. Pauses while the tab is hidden; stops on unmount.
  useEffect(() => {
    let stopped = false;
    const idle = async () => { while (!stopped && document.hidden) await sleep(400); };
    (async () => {
      await sleep(900);
      for (let k = 0; !stopped; k++) {
        await idle();
        if (stopped) return;
        setTypeIndex(k); setCycle(k);
        for (let i = 0; i < PHASES.length && !stopped; i++) {
          setPhase(i); setPhaseAt(performance.now());
          await sleep(PHASES[i]);
        }
        await sleep(HOLD);
      }
    })();
    return () => { stopped = true; };
  }, []);

  const open = useCallback((tab, opts) => onOpen(tab, opts), [onOpen]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'c' || e.key === 'C') { e.preventDefault(); open('compose'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const engine = configState.loading
    ? { dot: '#ff6017', text: 'Connecting to Mail Engine', live: false }
    : configState.error
      ? { dot: '#eb1700', text: 'Mail Engine unreachable', live: false }
      : { dot: '#328714', text: 'Mail Engine online', live: true };

  const works = [
    { tab: 'whats-new', name: 'What’s new', sub: 'Shipped but not yet announced', icon: aiIcon, color: '#8c3bbb', value: stats.whatsNew },
    { tab: 'queue', name: 'Queue', sub: 'Scheduled sends, going out on time', icon: calendarIcon, color: '#0f68b2', value: stats.queued },
    { tab: 'history', name: 'Sent history', sub: 'Everything delivered, searchable', icon: checkIcon, color: '#328714', value: stats.sent },
  ];

  return (
    <div ref={rootRef} className="cw" style={{ '--c': cat.color }}>
      <div className="cw-spot" />
      <div className="cw-grain" />

      <div className="cw-wrap">
        <header className="cw-top">
          <div className="cw-brand">
            <img src="/sh_logo.png" alt="GRA SmartHub" draggable={false} />
            <i />
            <div><b>Communication Center</b><small>Global Regulatory Affairs</small></div>
          </div>
          <div className="cw-chip" role="status" aria-live="polite">
            <span className={`cw-dot${engine.live ? ' live' : ''}`} style={{ '--dot': engine.dot }} />
            {engine.text}
            {config?.sender && !configState.error && (<><span className="sep" /><b>{config.sender}</b></>)}
            {configState.error && (<><span className="sep" /><button type="button" onClick={onRetryConfig}>Retry</button></>)}
          </div>
        </header>

        <div className="cw-stage">
          <section className="cw-flow">
            <div className="cw-eyebrow"><span className="cw-dot live" />Broadcast studio</div>
            <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="How a message goes out">
              {STEPS.map(([title, sub], i) => (
                <li key={title} className={`cw-step${phase === i ? ' on' : ''}${phase > i ? ' done' : ''}`}
                    style={{ '--d': `${PHASES[i]}ms` }}>
                  <span className="no">{String(i + 1).padStart(2, '0')}</span>
                  <b>{title}</b>
                  <small>{sub}</small>
                  <span className="bar"><i /></span>
                </li>
              ))}
            </ol>
            <div className="cw-ctas">
              <button type="button" className="cw-cta" onClick={() => open('compose')}>
                Compose a message <span className="arr">→</span>
              </button>
              {aiAvailable && (
                <button type="button" className="cw-ghost" onClick={() => open('compose', { ai: true })}>
                  <MaskIcon src={aiIcon} size={16} style={{ color: '#8c3bbb' }} />Draft with AI
                </button>
              )}
              <span className="cw-hint"><span className="cw-kbd">C</span> to compose</span>
            </div>
          </section>

          <div className="cw-scene" aria-hidden="true">
            {hero === 'globe'
              ? <div className="cw-hv"><Globe color={cat.color} phase={phase} phaseAt={phaseAt} tier={tier} /></div>
              : <Envelope cat={cat} phase={phase} cycle={cycle} logo="/sh_logo.png" />}
            <div className="cw-ticker">
              {cats.map((c, j) => (
                <div key={c.id} style={{ '--k': c.color }}
                     className={`cw-tk${j === typeIndex % cats.length && phase >= 0 ? ' on' : ''}${j < typeIndex % cats.length ? ' done' : ''}`}>
                  <span>{c.label}</span><i><em key={j === typeIndex % cats.length ? cycle : 'idle'} /></i>
                </div>
              ))}
            </div>
          </div>

          <section className="cw-kpis" aria-label="At a glance">
            {[['history', 'Messages sent', stats.sent], ['queue', 'Queued', stats.queued], ['compose', 'Templates', stats.templates]].map(([tab, label, value]) => (
              <button key={label} type="button" className="cw-stat" onClick={() => open(tab)} title={`Open ${label.toLowerCase()}`}>
                <b><Stat value={value} /><span className="go">→</span></b>
                <span>{label}</span>
              </button>
            ))}
          </section>
        </div>

        <section className="cw-pick">
          <div>
            <div className="cw-ph">Start with a message type</div>
            <div className="cw-types">
              {configState.loading && !categories.length
                ? [0, 1, 2, 3].map((i) => <div key={i} className="cw-skelcard" />)
                : cats.map((c, i) => (
                  <button key={c.id} type="button" className="cw-card cw-type" style={{ '--k': c.color, animationDelay: `${0.65 + i * 0.07}s` }}
                          onClick={() => open('compose', { category: c.id })}>
                    <div className="mini"><div className="bn">{hints(c.id).bannerTitle}</div><i /><i /></div>
                    <div className="nm">{c.label}</div>
                    <div className="pf">{c.prefix || 'No prefix'}</div>
                    <div className="ds">{TYPE_COPY[c.id] || 'A message in the SmartHub house style.'}</div>
                  </button>
                ))}
            </div>
          </div>
          <div>
            <div className="cw-ph">Or pick up where you left off</div>
            <div className="cw-works">
              {works.map((w) => (
                <button key={w.tab} type="button" className="cw-card cw-work" style={{ '--k': w.color }} onClick={() => open(w.tab)}>
                  <span className="ic"><MaskIcon src={w.icon} size={17} /></span>
                  <span className="tx"><b>{w.name}</b><span>{w.sub}</span></span>
                  <span className="badge"><Stat value={w.value} /></span>
                  <span className="go" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}