const BASE='http://localhost:8080'; const PW=process.env.PW;
const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:PW+'-admin'})});
const cookie=r.headers.get('set-cookie').split(';')[0];
const g=(p,m='GET',b)=>fetch(BASE+'/api'+p,{method:m,headers:{cookie,'content-type':'application/json'},body:b?JSON.stringify(b):undefined}).then(async x=>({s:x.status,b:await x.json().catch(()=>null)}));
const c=await g('/connections'); const yt=c.b.find(x=>x.key==='youtube'); console.log('youtube card:', yt.status, '|', yt.blocker, '| redirect', yt.oauth.redirect_uri);
console.log('drive card:', c.b.find(x=>x.key==='google_drive').status);
const st=await fetch(BASE+'/api/oauth/google/start',{headers:{cookie},redirect:'manual'}); console.log('connect w/o client id ->', st.status);
const up=await g('/videos','GET'); const v=up.b.find(x=>x.drive_file_id); const u=await g(`/videos/${v.id}/youtube/upload`,'POST',{visibility:'private'}); console.log('upload w/o connection ->', u.s, u.b.error);
const sy=await g('/videos/sync-drive','POST'); console.log('drive re-import ->', sy.s, JSON.stringify(sy.b));
