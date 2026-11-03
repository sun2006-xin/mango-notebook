package cn.dailytodo.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 应用内下载 APK 并调起系统安装器。
 *
 * <p>为什么需要这个插件：原来点「更新」是 `openApkDownload()` 打开系统浏览器，
 * 用户在浏览器里下完还得去通知栏/文件管理器找那个 apk 再点一次。多绕两步，
 * 而且小米/华为的文件管理器经常把下载的包藏在很深的目录里。
 *
 * <p>能做到什么程度：**下载全自动，安装要用户点一次**。Android 8.0 起禁止应用静默
 * 安装 APK（侧载），这一步是平台规则，任何工具都绕不过。所以目标是把链路压到
 * 「点更新 → 进度条 → 系统安装器弹出 → 点安装」。
 *
 * <p>三个必须处理的现实问题：
 * <ul>
 *   <li><b>安装未知应用权限</b>：Android 8+ 需要用户在系统设置里给本应用授权。
 *       没授权时**不能硬失败**，要把用户带到那个开关页，否则他只会看到"没反应"。</li>
 *   <li><b>FileProvider</b>：Android 7+ 不允许用 file:// 把文件交给别的应用，
 *       必须走 content:// + 临时读权限，否则安装器一打开就报"解析包出错"。</li>
 *   <li><b>进度通知限流</b>：一次下载能回调几百次，全推给 JS 会把 bridge 灌满、
 *       界面反而卡住。所以按时间节流。</li>
 * </ul>
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    private static final String APK_NAME = "mango-update.apk";
    /** 进度回调的最小间隔（毫秒）。120ms ≈ 每秒 8 次，肉眼够顺滑 */
    private static final long PROGRESS_INTERVAL_MS = 120;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;

    /** 同一时刻只允许一个下载（连点两下不该跑两条线程） */
    private volatile boolean downloading = false;

    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("下载地址为空");
            return;
        }
        if (downloading) {
            call.reject("正在下载中，请稍候");
            return;
        }
        downloading = true;

        final File target = new File(getContext().getCacheDir(), APK_NAME);

        new Thread(() -> {
            HttpURLConnection conn = null;
            FileOutputStream out = null;
            InputStream in = null;
            try {
                // 上一版残留先清掉，避免"下到一半的包"被当成完整包去安装
                if (target.exists() && !target.delete()) {
                    // 删不掉不算致命：下面会从头覆盖写
                    target.renameTo(new File(getContext().getCacheDir(), APK_NAME + ".old"));
                }

                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Accept", "application/vnd.android.package-archive,*/*");
                conn.connect();

                final int code = conn.getResponseCode();
                if (code != HttpURLConnection.HTTP_OK) {
                    throw new IllegalStateException("HTTP " + code);
                }
                final long total = conn.getContentLengthLong();

                in = conn.getInputStream();
                out = new FileOutputStream(target);
                byte[] buffer = new byte[64 * 1024];
                long done = 0;
                long lastEmit = 0;
                int read;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                    done += read;
                    final long now = System.currentTimeMillis();
                    if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                        lastEmit = now;
                        emitProgress(done, total);
                    }
                }
                out.flush();
                emitProgress(done, total);

                downloading = false;
                install(target, call);
            } catch (Exception e) {
                downloading = false;
                if (target.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    target.delete();
                }
                call.reject("下载失败：" + e.getMessage());
            } finally {
                try {
                    if (out != null) out.close();
                } catch (Exception ignored) {
                }
                try {
                    if (in != null) in.close();
                } catch (Exception ignored) {
                }
                if (conn != null) conn.disconnect();
            }
        }).start();
    }

    /**
     * 调起系统安装器。
     *
     * <p>没拿到「安装未知应用」权限时**不报错**，而是把用户送到系统开关页，
     * 并把 `needsPermission = true` 回给 JS —— 前端据此提示"去允许一下再点更新"。
     * 报错的话用户只会看到"更新失败"，然后不知道下一步做什么。
     */
    private void install(final File apk, final PluginCall call) {
        if (!apk.exists() || apk.length() == 0) {
            call.reject("安装包为空，请重试");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent settings = new Intent(
                        android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(settings);
            } catch (Exception ignored) {
                // 个别定制 ROM 没有这个页面 —— 那就只能靠浏览器兜底
            }
            JSObject ret = new JSObject();
            ret.put("ok", false);
            ret.put("needsPermission", true);
            call.resolve(ret);
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("needsPermission", false);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("无法调起安装器：" + e.getMessage());
        }
    }

    /** 进度通知（切到主线程再发，避免在后台线程碰 WebView） */
    private void emitProgress(final long done, final long total) {
        if (getActivity() == null) return;
        getActivity().runOnUiThread(() -> {
            JSObject data = new JSObject();
            data.put("done", done);
            data.put("total", total);
            notifyListeners("progress", data);
        });
    }
}
