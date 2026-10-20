'use strict';
// Loaded synchronously in <head>, so the saved theme is applied before the first paint.
// Each theme is independently scoped. The saved choice is applied before first paint.
globalThis.StarportTheme=(()=>{
  const themes={sea:{color:'#0a1321',icon:'/icon.svg'},port:{color:'#05070c',icon:'/assets/spaceport-icon.svg'},'deep-space':{color:'#0c0f13',icon:'/assets/deep-space-icon.svg'}};
  let theme='sea';
  try{const saved=localStorage.getItem('starport-theme');if(Object.hasOwn(themes,saved))theme=saved;}catch{}
  function apply(value){
    theme=Object.hasOwn(themes,value)?value:'sea';
    document.documentElement.dataset.theme=theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',themes[theme].color);
    // The active in-app theme has its own mark; external app icons stay Azure.
    document.querySelector('link[rel="icon"]')?.setAttribute('href',themes[theme].icon);
    for(const button of document.querySelectorAll('[data-theme-choice]'))button.setAttribute('aria-pressed',String(button.dataset.themeChoice===theme));
  }
  function set(value){apply(value);try{localStorage.setItem('starport-theme',theme);}catch{}}
  apply(theme);
  document.addEventListener('DOMContentLoaded',()=>{
    for(const button of document.querySelectorAll('[data-theme-choice]'))button.addEventListener('click',()=>set(button.dataset.themeChoice));
    apply(theme);
  });
  return {get theme(){return theme;},set};
})();
