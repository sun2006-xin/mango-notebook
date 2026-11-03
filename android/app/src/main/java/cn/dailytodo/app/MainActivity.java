package cn.dailytodo.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /*
         * ⚠️ 注册必须写在 super.onCreate() **之前**：
         * BridgeActivity 在 onCreate 里就把 bridge 建好并开始加载前端，
         * 之后注册的插件对首个页面不可见 —— 表现是 JS 侧 `Capacitor.Plugins.X`
         * 拿到一个"未实现"的壳，调用直接 reject。
         */
        registerPlugin(ApkInstallerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
