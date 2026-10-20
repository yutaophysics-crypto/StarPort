import { createPrivateKey,createPublicKey,generateKeyPairSync,sign,verify,randomUUID } from 'node:crypto';
import { existsSync,readFileSync,writeFileSync,chmodSync } from 'node:fs';
import { fail } from '../collaboration/store.mjs';

export function accountUrl(value){let url;try{url=new URL(value);}catch{throw fail('账号中心地址无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!['/account','/account/'].includes(url.pathname))throw fail('账号中心地址应为 HTTPS 地址，以 /account 结尾');
  if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw fail('远程账号中心必须使用 HTTPS');return url.origin+'/account';
}
export function signingKey(file){if(!existsSync(file)){const {privateKey}=generateKeyPairSync('ed25519');writeFileSync(file,privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});}chmodSync(file,0o600);const key=createPrivateKey(readFileSync(file));if(key.asymmetricKeyType!=='ed25519')throw Error('账号签名密钥类型无效');return key;}
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
// The single encoding is essential: verify precisely the bytes that were signed.
export function signGrant(key,claims){const data=encode({alg:'EdDSA',typ:'starport-login+jwt'})+'.'+encode(claims);return data+'.'+sign(null,Buffer.from(data),key).toString('base64url');}
export function loginGrant(key,{issuer,audience,user,nonce,selectionToken,clock=Date.now}){const iat=Math.floor(clock()/1000);return signGrant(key,{iss:accountUrl(issuer),aud:audience,sub:user.id,username:user.username,name:user.name,nonce,...selectionToken?{selectionToken}:{},jti:randomUUID(),iat,exp:iat+60});}
export function verifyGrant(token,key,{issuer,audience,clock=Date.now}){
  try{if(typeof token!=='string'||token.length>8192)throw Error();const parts=token.split('.');if(parts.length!==3||parts.some(p=>!/^[A-Za-z0-9_-]+$/.test(p)))throw Error();const header=JSON.parse(Buffer.from(parts[0],'base64url')),claims=JSON.parse(Buffer.from(parts[1],'base64url'));
    if(header.alg!=='EdDSA'||header.typ!=='starport-login+jwt'||Object.keys(header).some(k=>!['alg','typ'].includes(k)))throw Error();
    if(!verify(null,Buffer.from(parts[0]+'.'+parts[1]),key,Buffer.from(parts[2],'base64url')))throw Error();const time=Math.floor(clock()/1000);
    if(claims.iss!==accountUrl(issuer)||claims.aud!==audience||!Number.isInteger(claims.iat)||!Number.isInteger(claims.exp)||claims.exp<=time||claims.iat>time+5||claims.exp-claims.iat>60||time-claims.iat>65)throw Error();
    if(!/^[a-f0-9-]{36}$/.test(claims.sub)||!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(claims.username)||typeof claims.name!=='string'||!claims.name.trim()||claims.name.length>80||!/^[A-Za-z0-9_-]{43}$/.test(claims.nonce)||typeof claims.jti!=='string'||claims.selectionToken!==undefined&&(typeof claims.selectionToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(claims.selectionToken)))throw Error();return claims;
  }catch{throw fail('账号中心的登录凭证无效或已过期，请重新登录',401);}
}
export class AccountVerifier {
  constructor(issuer,{clock=Date.now,publicKeyFile=null}={}){this.issuer=accountUrl(issuer);this.clock=clock;this.publicKeyFile=publicKeyFile;this.key=null;this.loaded=0;}
  async verify(token,audience){if(!this.key||this.clock()-this.loaded>300000){let text;if(this.publicKeyFile){try{text=readFileSync(this.publicKeyFile,'utf8');}catch{throw fail('账号中心签名公钥尚未准备好，请稍后重试',503);}}else{const response=await fetch(this.issuer+'/public-key',{redirect:'error',signal:AbortSignal.timeout(8000)});if(!response.ok)throw fail('账号中心暂时不可用',503);text=await response.text();}if(text.length>2048)throw fail('账号中心签名密钥无效',503);const key=createPublicKey(text);if(key.asymmetricKeyType!=='ed25519')throw fail('账号中心签名密钥无效',503);this.key=key;this.loaded=this.clock();}return verifyGrant(token,this.key,{issuer:this.issuer,audience,clock:this.clock});}
}
