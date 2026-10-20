const mode=process.env.STARPORT_USAGE_FIXTURE_MODE;
if(mode==='silent')console.error('Print mode: not authenticated, trying silent auth');
if(mode==='login'){console.log('Authentication required. Please visit the URL to log in:');setInterval(()=>{},1000);}
else if(mode==='timeout')setInterval(()=>{},1000);
else{console.log('\u001b[32mModel quota: 81% remaining\u001b[0m\nResets in 3h\n<img src=x onerror=alert(1)>');}
