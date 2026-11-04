/** Fixed readers use semantic links, text direction and button labels, never generated CSS classes. */
export const threadsIdentity = String.raw`Array.from(document.querySelectorAll('[role="navigation"] a[href^="/@"],nav a[href^="/@"]')).find(a=>a.querySelector('[aria-label="Profile"],[title="Profile"]')||a.getAttribute('aria-label')==='Profile')?.getAttribute('href')?.match(/^\/@([A-Za-z0-9_.]+)\/?$/)?.[1]??null`;
export const threadsIdentityScript = `JSON.stringify({handle:${threadsIdentity}})`;
export const threadsPostsScript = String.raw`JSON.stringify((()=>{
 const seen=new Set();return Array.from(document.querySelectorAll('a[href*="/post/"]')).filter(a=>{const href=a.getAttribute('href');if(!/^\/@[A-Za-z0-9_.]{1,30}\/post\/[A-Za-z0-9_-]+$/.test(href??'')||seen.has(href))return false;seen.add(href);return true}).slice(0,10).map(a=>{
 let row=a;for(let i=0;i<12&&row.parentElement;i++){if(row.querySelector('svg[title="Comment"],svg[aria-label="Reply"],svg[aria-label="Comment"]'))break;row=row.parentElement;}
  const body=Array.from(row.querySelectorAll('[dir="auto"]')).filter(e=>!e.querySelector('time,svg')&&!e.closest('a,time,[role="button"]')&&e.textContent.trim()).map(e=>{const copy=e.cloneNode(true);copy.querySelectorAll('button,[role="button"]').forEach(button=>button.remove());return copy.textContent.trim()}).filter((text,index,all)=>text&&all.indexOf(text)===index).join(' ').slice(0,1800);
 return {text:body,body,url:a.getAttribute('href')};});})())`;
export const threadsComposer = '[role="dialog"] [contenteditable="true"][role="textbox"]';
export const threadsSubmitButtons = '[role="dialog"] :is(button,[role="button"])';
export const threadsSubmitIndex = `(()=>{
 const buttons=Array.from(document.querySelectorAll(${JSON.stringify(threadsSubmitButtons)}));
 const matches=buttons.filter(e=>{const r=e.getBoundingClientRect();return e.textContent.trim()==='Post'&&r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'});
 if(matches.length!==1)throw Error('Cannot identify the Threads submit button');
 return String(buttons.indexOf(matches[0]));})()`;
export const threadsSentScript = `JSON.stringify({empty:!document.querySelector('${threadsComposer}')})`;
