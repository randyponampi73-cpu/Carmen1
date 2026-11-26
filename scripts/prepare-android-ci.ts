import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapeXml, validateApkConfig } from '../server/security';

export interface AssembleAndroidProjectOptions {
  webDistDir: string;
  outDir: string;
  packageId?: string;
  appName?: string;
  versionName?: string;
  versionCode?: number;
}

export function assembleAndroidGradleProject(opts: AssembleAndroidProjectOptions): {
  outDir: string;
  packageId: string;
  assetFilesCopied: number;
} {
  const webDistDir = path.resolve(opts.webDistDir);
  if (!fs.existsSync(path.join(webDistDir, 'index.html'))) {
    throw new Error(`Direktori build frontend tidak ditemukan atau belum dibuild (missing index.html): ${webDistDir}`);
  }

  const rawPkg = (opts.packageId || 'id.carmen.app').trim();
  const validation = validateApkConfig({
    appName: opts.appName || 'CARMEN App',
    packageId: rawPkg,
    versionName: opts.versionName || '1.0.0',
    versionCode: opts.versionCode ?? 1,
    iconColor: '#C8324B',
    buildType: 'debug',
  });
  if (!validation.valid || !validation.sanitized) {
    throw new Error(validation.error || 'Konfigurasi Android packageId tidak valid.');
  }
  const cfg = validation.sanitized;

  const outDir = path.resolve(opts.outDir);
  const appDir = path.join(outDir, 'app');
  const pkgRelPath = cfg.packageId.split('.').join(path.sep);
  const javaDir = path.join(appDir, 'src', 'main', 'java', pkgRelPath);
  const resValuesDir = path.join(appDir, 'src', 'main', 'res', 'values');
  const assetsPublicDir = path.join(appDir, 'src', 'main', 'assets', 'public');

  fs.mkdirSync(javaDir, { recursive: true });
  fs.mkdirSync(resValuesDir, { recursive: true });
  fs.mkdirSync(assetsPublicDir, { recursive: true });

  fs.writeFileSync(
    path.join(outDir, 'settings.gradle'),
    `pluginManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}
rootProject.name = "CarmenAndroidApp"
include(":app")
`
  );

  fs.writeFileSync(
    path.join(outDir, 'build.gradle'),
    `plugins {
  id 'com.android.application' version '8.5.2' apply false
}
`
  );

  fs.writeFileSync(
    path.join(outDir, 'gradle.properties'),
    `org.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.nonTransitiveRClass=true
`
  );

  fs.writeFileSync(
    path.join(appDir, 'build.gradle'),
    `plugins {
  id 'com.android.application'
}

android {
  namespace ${JSON.stringify(cfg.packageId)}
  compileSdk 34

  defaultConfig {
    applicationId ${JSON.stringify(cfg.packageId)}
    minSdk 24
    targetSdk 34
    versionCode ${cfg.versionCode}
    versionName ${JSON.stringify(cfg.versionName)}
  }

  buildTypes {
    release {
      minifyEnabled false
    }
  }

  compileOptions {
    sourceCompatibility JavaVersion.VERSION_17
    targetCompatibility JavaVersion.VERSION_17
  }
}
`
  );

  fs.writeFileSync(
    path.join(appDir, 'src', 'main', 'AndroidManifest.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <application
    android:allowBackup="false"
    android:label="@string/app_name">
    <activity
      android:name=".MainActivity"
      android:exported="true"
      android:configChanges="orientation|keyboardHidden|screenSize">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`
  );

  fs.writeFileSync(
    path.join(resValuesDir, 'strings.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="app_name">${escapeXml(cfg.appName)}</string>
</resources>
`
  );

  fs.writeFileSync(
    path.join(javaDir, 'MainActivity.java'),
    `package ${cfg.packageId};

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    WebView webView = new WebView(this);
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    webView.setWebViewClient(new WebViewClient());
    webView.loadUrl("file:///android_asset/public/index.html");
    setContentView(webView);
  }
}
`
  );

  let copied = 0;
  const copyAssets = (srcDir: string, dstDir: string) => {
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const src = path.join(srcDir, ent.name);
      const dst = path.join(dstDir, ent.name);
      if (ent.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        copyAssets(src, dst);
      } else if (ent.isFile()) {
        fs.copyFileSync(src, dst);
        copied += 1;
      }
    }
  };
  copyAssets(webDistDir, assetsPublicDir);

  return { outDir, packageId: cfg.packageId, assetFilesCopied: copied };
}

const isDirectExecution =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  const args = process.argv.slice(2);
  let outDir = '.android-ci';
  let webDistDir = 'dist';
  let packageId = 'id.carmen.app';
  let appName = 'CARMEN App';

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out' && args[i + 1]) {
      outDir = args[++i];
    } else if (args[i] === '--dist' && args[i + 1]) {
      webDistDir = args[++i];
    } else if (args[i] === '--package-id' && args[i + 1]) {
      packageId = args[++i];
    } else if (args[i] === '--app-name' && args[i + 1]) {
      appName = args[++i];
    }
  }

  const res = assembleAndroidGradleProject({ webDistDir, outDir, packageId, appName });
  console.log(JSON.stringify(res, null, 2));
}
