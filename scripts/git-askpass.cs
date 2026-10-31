using System;
using System.Net;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Collections.Generic;
class StarportGitAskpass {
 static int Main(string[] args) {
  if(args.Length!=1||args[0].Length>8192)return 1;
  var match=Regex.Match(args[0],"^(Username|Password) for '([^']+)'");if(!match.Success)return 1;
  try {
   var target=new Uri(match.Groups[2].Value);var url=new Uri(Environment.GetEnvironmentVariable("STARPORT_GIT_CREDENTIAL_URL")??"");
   if(url.Scheme!="http"||url.Host!="127.0.0.1"||url.AbsolutePath!="/credential")return 1;
   var json=new JavaScriptSerializer();
   var input=new Dictionary<string,object>{{"protocol",target.Scheme},{"host",target.Host},{"path",target.AbsolutePath.TrimStart('/')},{"cwd",Environment.CurrentDirectory}};
   using(var client=new WebClient()){
    client.Proxy=null;client.Headers["Content-Type"]="application/json";client.Headers["X-Git-Credential"]=Environment.GetEnvironmentVariable("STARPORT_GIT_CREDENTIAL_KEY");
    var value=json.Deserialize<Dictionary<string,string>>(client.UploadString(url,"POST",json.Serialize(input)));
    var output=value[match.Groups[1].Value=="Username"?"username":"password"];
    if(output.IndexOfAny(new char[]{'\r','\n','\0'})>=0)return 1;Console.WriteLine(output);return 0;
   }
  }catch{return 1;}
 }
}
