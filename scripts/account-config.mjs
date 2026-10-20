import { existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountUrl } from '../src/accounts/protocol.mjs';
export function defaultAccountCenter(root,environment=process.env){if(environment.STARPORT_ACCOUNT_URL)return accountUrl(environment.STARPORT_ACCOUNT_URL);const file=join(root,'config/account-center.json');if(!existsSync(file))return null;return accountUrl(JSON.parse(readFileSync(file,'utf8')).url);}
