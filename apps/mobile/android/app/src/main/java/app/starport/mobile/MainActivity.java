package app.starport.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.graphics.Color;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.net.URI;

public final class MainActivity extends Activity {
    private WebView browser;
    private TextView heading;
    private LinearLayout welcome;
    private URI server;
    private boolean debug;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debug) WebView.setWebContentsDebuggingEnabled(true);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setBackgroundColor(Color.rgb(10, 23, 37));

        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(16), 0, dp(8), 0);
        heading = new TextView(this);
        heading.setText("星港");
        heading.setTextSize(16);
        heading.setSingleLine();
        toolbar.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        Button address = new Button(this);
        address.setText("服务器");
        address.setOnClickListener(view -> configure());
        toolbar.addView(address);
        body.addView(toolbar);

        welcome = new LinearLayout(this);
        welcome.setGravity(Gravity.CENTER);
        welcome.setOrientation(LinearLayout.VERTICAL);
        welcome.setPadding(dp(24), dp(20), dp(24), dp(20));
        TextView prompt = new TextView(this);
        prompt.setText("连接星港服务器后，查看你的电脑和对话。");
        prompt.setGravity(Gravity.CENTER);
        welcome.addView(prompt);
        Button connect = new Button(this);
        connect.setText("连接服务器");
        connect.setOnClickListener(view -> configure());
        welcome.addView(connect);
        body.addView(welcome, new LinearLayout.LayoutParams(-1, 0, 1));

        browser = new WebView(this);
        browser.setBackgroundColor(Color.rgb(10, 23, 37));
        browser.getSettings().setJavaScriptEnabled(true);
        browser.getSettings().setDomStorageEnabled(true);
        browser.getSettings().setAllowFileAccess(false);
        browser.getSettings().setAllowContentAccess(false);
        browser.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        browser.getSettings().setUserAgentString(browser.getSettings().getUserAgentString() + " StarportMobile/1");
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false);
        browser.setWebChromeClient(new WebChromeClient());
        browser.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return !allowed(req.getUrl());
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError error) {
                if (req.isForMainFrame()) showConnectionError("无法打开服务器，请检查地址和网络后重试。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse error) {
                if (req.isForMainFrame() && req.getUrl().getPath().equals("/remote/") && error.getStatusCode() == 404)
                    showConnectionError("这台服务器还未更新到支持手机访问的版本。");
            }
        });
        browser.setVisibility(View.GONE);
        body.addView(browser, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(body);

        String stored = getPreferences(MODE_PRIVATE).getString("server", "");
        if (debug && getIntent().hasExtra("testServer")) stored = getIntent().getStringExtra("testServer");
        URI existing = parse(stored);
        if (existing != null) load(existing);
    }

    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }

    private boolean allowed(Uri destination) {
        if (server == null || destination.getUserInfo() != null) return false;
        if (server.getScheme().equalsIgnoreCase(destination.getScheme()) &&
            server.getHost().equalsIgnoreCase(destination.getHost()) && effectivePort(server.getScheme(), server.getPort()) == effectivePort(destination.getScheme(), destination.getPort())) return true;
        // A server may federate its login to a separate HTTPS account center.
        return "https".equalsIgnoreCase(destination.getScheme()) && destination.getHost() != null && "/account/".equals(destination.getPath());
    }

    private static int effectivePort(String scheme, int port) {
        return port >= 0 ? port : ("https".equalsIgnoreCase(scheme) ? 443 : 80);
    }

    private URI parse(String value) {
        if (value == null) return null;
        try {
            URI uri = new URI(value.trim());
            boolean secure = "https".equalsIgnoreCase(uri.getScheme());
            boolean local = debug && "http".equalsIgnoreCase(uri.getScheme()) && "127.0.0.1".equals(uri.getHost());
            if ((!secure && !local) || uri.getHost() == null || uri.getUserInfo() != null ||
                uri.getQuery() != null || uri.getFragment() != null ||
                (!uri.getPath().isEmpty() && !"/".equals(uri.getPath()))) return null;
            return new URI(uri.getScheme().toLowerCase(java.util.Locale.ROOT), null, uri.getHost(), uri.getPort(), null, null, null);
        } catch (Exception invalid) { return null; }
    }

    private void load(URI address) {
        server = address;
        getPreferences(MODE_PRIVATE).edit().putString("server", address.toString()).apply();
        heading.setText("星港 · " + address.getHost());
        welcome.setVisibility(View.GONE);
        browser.setVisibility(View.VISIBLE);
        browser.loadUrl(address + "/remote/");
    }

    private void configure() {
        EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setHint("https://starport.example.com");
        field.setSingleLine(true);
        if (server != null) field.setText(server.toString());
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("星港服务器")
            .setView(field).setNegativeButton("取消", null).setPositiveButton("连接", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            URI address = parse(field.getText().toString());
            if (address == null) { field.setError("请输入 HTTPS 服务器地址"); return; }
            load(address);
            dialog.dismiss();
        }));
        dialog.show();
    }

    private void showConnectionError(String message) {
        if (isFinishing() || !browser.isShown()) return;
        new AlertDialog.Builder(this).setMessage(message).setNegativeButton("取消", null)
            .setPositiveButton("设置地址", (dialog, which) -> configure()).show();
    }

    @Override protected void onPause() {
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override public void onBackPressed() {
        // The mobile workspace keeps navigation within the selected computer.
        if (browser.isShown()) browser.evaluateJavascript(
            "(()=>{let w=document.querySelector('#workspace');if(!w)return false;if(w.dataset.page==='chat'){document.querySelector('#back-chats').click();return true;}if(w.dataset.page==='chats'){document.querySelector('#back-devices').click();return true;}return false;})()",
            value -> { if (!"true".equals(value)) super.onBackPressed(); });
        else super.onBackPressed();
    }
}
