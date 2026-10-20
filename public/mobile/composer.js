'use strict';
(()=>{
  function bind(textarea,form,canSend){
    const handler=event=>{
      if(event.key!=='Enter'||event.isComposing||event.keyCode===229)return;
      if(event.shiftKey||event.ctrlKey){
        event.preventDefault();
        if(textarea.maxLength>=0&&textarea.value.length-(textarea.selectionEnd-textarea.selectionStart)+1>textarea.maxLength)return;
        textarea.setRangeText('\n',textarea.selectionStart,textarea.selectionEnd,'end');
        textarea.dispatchEvent(new Event('input',{bubbles:true}));return;
      }
      if(event.altKey||event.metaKey)return;
      event.preventDefault();if(canSend())form.requestSubmit();
    };
    textarea.addEventListener('keydown',handler);
    return ()=>textarea.removeEventListener('keydown',handler);
  }
  globalThis.StarportGroupComposer={bind};
})();
