// Every tool Starport can run. Kept apart from providers.mjs so storage and memory code can
// check an id without loading the tool adapters.
export const PROVIDER_IDS=Object.freeze(['codex','claude','antigravity','deepseek','ollama']);
export const isProviderId=id=>PROVIDER_IDS.includes(id);
