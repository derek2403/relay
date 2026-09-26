export const catalog = {
 codex:{name:'Codex',unit:'usd',service:'OpenAI'},openai:{name:'OpenAI',unit:'usd',service:'OpenAI'},anthropic:{name:'Anthropic',unit:'usd'},gemini:{name:'Gemini',unit:'usd'},github:{name:'GitHub',unit:'access'},railway:{name:'Railway',unit:'access'},vercel:{name:'Vercel',unit:'access'},linear:{name:'Linear',unit:'access'},canva:{name:'Canva',unit:'access'},hubspot:{name:'HubSpot',unit:'access'},mailchimp:{name:'Mailchimp',unit:'access'},stripe:{name:'Stripe',unit:'access'},notion:{name:'Notion',unit:'access'},slack:{name:'Slack',unit:'access'}
};
export function seedOrg(){
 const bundle=(keys,dollars,images)=>Object.fromEntries(keys.map(k=>[k,catalog[k].unit==='access'?null:k==='images'?images:dollars]));
 const org={id:'acme',name:'acme',label:'acme.eth',parent:null,type:'company',wallet:'0x'+'1'.repeat(40),limits:bundle(Object.keys(catalog),10000,1000),period:'month',usage:{}};
 const departments=[['eng','Engineering',['dev','platform'],['codex','openai','anthropic','gemini','github','railway','vercel','linear']],['marketing','Marketing',['content','growth'],['openai','gemini','canva','hubspot','mailchimp']],['business','Business',['sales','finance'],['stripe','notion','slack','hubspot','openai']]];
 const nodes=[org];let n=2;for(const [id,label,teams,keys] of departments){nodes.push({id,name:id,label,parent:'acme',type:'department',wallet:'0x'+String(n++).repeat(40),limits:bundle(keys,3000,300),period:'month',usage:{}});for(const team of teams)nodes.push({id:team,name:team,label:team,parent:id,type:'team',wallet:'0x'+String(n++).slice(-1).repeat(40),limits:bundle(keys,1000,100),period:'month',usage:{}})}return nodes;
}
export const get=(nodes,id)=>nodes.find(n=>n.id===id);
export function chain(nodes,n){const result=[];while(n){result.push(n);n=n.parent?get(nodes,n.parent):null}return result}
export function full(nodes,n){return chain(nodes,n).map(n=>n.parent?n.name:n.name+'.eth').join('.')}
export function descendants(nodes,id){return nodes.filter(n=>n.id!==id&&chain(nodes,n).some(p=>p.id===id))}
export function status(nodes,n,now=Date.now()){const c=chain(nodes,n);if(c.some(p=>p.removed))return 'Revoked';if(c.some(p=>p.until&&p.until<=now))return 'Expired';return 'Active'}
const month=now=>new Date(now).toISOString().slice(0,7);
export function used(n,key,now=Date.now()){return n.period==='month'&&n.usageMonth!==month(now)?0:n.usage[key]||0}
export function allowed(nodes,n){return Object.keys(n.limits).filter(k=>chain(nodes,n).every(p=>Object.hasOwn(p.limits,k)))}
export function remaining(nodes,n,key,now=Date.now()){if(status(nodes,n,now)!=='Active'||!allowed(nodes,n).includes(key))return 0;return Math.max(0,Math.min(...chain(nodes,n).map(p=>p.limits[key]===null?Infinity:p.limits[key]-used(p,key,now))))}
export function validate(nodes,parent,{name,wallet,limits,until},editing){
 if(status(nodes,parent)!=='Active')throw Error('The parent is inactive.');
 if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))throw Error('Use lowercase letters, numbers and hyphens.');
 if(!/^0x[0-9a-fA-F]{40}$/.test(wallet))throw Error('Enter a complete Ethereum wallet address (0x + 40 hex characters).');
 if(nodes.some(n=>n.parent===parent.id&&n.name===name&&!n.removed&&n.id!==editing))throw Error('This name already exists under the parent.');
 if(!Object.keys(limits).length)throw Error('Select at least one API.');
 for(const [key,limit] of Object.entries(limits)){if(!allowed(nodes,parent).includes(key))throw Error('The parent does not allow '+key+'.');if(catalog[key].unit!=='access'&&(!Number.isFinite(limit)||limit<0||limit>parent.limits[key]||(catalog[key].unit==='count'&&!Number.isInteger(limit))))throw Error('Enter a valid '+catalog[key].name+' limit within the parent allowance.');}
 if(until&&until<=Date.now())throw Error('Expiry must be in the future.');
 if(parent.until&&(!until||until>parent.until))throw Error('Expiry cannot exceed the parent session.');
}
export function addIdentity(nodes,parent,values){validate(nodes,parent,values);const types={team:'member',member:'agent',agent:'subagent'};if(!types[parent.type])throw Error('Create members under teams; agents and subagents are created through the CLI demo.');const n={...values,id:'identity-'+crypto.randomUUID(),label:values.name,parent:parent.id,type:types[parent.type],usage:{},usageMonth:month(Date.now())};nodes.push(n);return n}
export function consume(nodes,n,key,amount,now=Date.now()){
 if(status(nodes,n,now)!=='Active')throw Error('Access revoked or expired: '+full(nodes,n));
 if(!allowed(nodes,n).includes(key))throw Error('API not allowed by every parent.');
 if(!Number.isFinite(amount)||amount<0||(catalog[key].unit==='count'&&!Number.isInteger(amount)))throw Error('Invalid usage amount.');
 if(remaining(nodes,n,key,now)<amount)throw Error('Allowance exhausted for '+catalog[key].name+'.');
 for(const p of chain(nodes,n)){if(p.period==='month'&&p.usageMonth!==month(now)){p.usage={};p.usageMonth=month(now)}p.usage[key]=(p.usage[key]||0)+amount}return amount;
}

export function seedDemo(){
 const nodes=seedOrg(),wallet='0x'+'a'.repeat(40),now=Date.now();
 const user=addIdentity(nodes,get(nodes,'dev'),{name:'derek',wallet,limits:{codex:20,openai:5,github:null,linear:null},period:'month'});
 const agent=addIdentity(nodes,user,{name:'codex',wallet:'0x'+'b'.repeat(40),limits:{codex:5,openai:2},period:'session',until:now+8*3600000});
 const research=addIdentity(nodes,agent,{name:'research',wallet:'0x'+'c'.repeat(40),limits:{codex:1},period:'session',until:now+20*60000});
 const review=addIdentity(nodes,agent,{name:'review',wallet:'0x'+'d'.repeat(40),limits:{openai:1},period:'session',until:now+20*60000});
 consume(nodes,agent,'codex',1.5);consume(nodes,research,'codex',.75);consume(nodes,review,'openai',1);
 const names={platform:'maya',content:'hana',growth:'leo',sales:'nina',finance:'omar'};
 for(const [team,name] of Object.entries(names)){
  const parent=get(nodes,team),keys=Object.keys(parent.limits);
  const limits=amount=>Object.fromEntries(keys.map(k=>[k,catalog[k].unit==='access'?null:catalog[k].unit==='count'?2:amount]));
  const member=addIdentity(nodes,parent,{name,wallet,limits:limits(30),period:'month'});
  const worker=addIdentity(nodes,member,{name:'assistant',wallet:'0x'+'b'.repeat(40),limits:limits(10),period:'session',until:now+8*3600000});
  const child=addIdentity(nodes,worker,{name:'research',wallet:'0x'+'c'.repeat(40),limits:limits(3),period:'session',until:now+3600000});
  const metered=keys.find(k=>catalog[k].unit==='usd');if(metered){consume(nodes,worker,metered,1.5);consume(nodes,child,metered,.75)}
 }
 return nodes;
}
