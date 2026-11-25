// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
package com.twindesk.android

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember

internal object RuntimeGrant {
    fun granted(ctx: Context, permission: String) =
        ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    fun requestable(deniedBefore: Boolean, rationale: Boolean) = !deniedBefore || rationale

    fun requestable(activity: Activity, store: Store, permissions: List<String>) =
        permissions.filter { !granted(activity, it) && requestable(
            store.flag("permission.denied.$it", false), activity.shouldShowRequestPermissionRationale(it),
        ) }

    fun record(store: Store, permission: String, granted: Boolean) =
        store.setFlag("permission.denied.$permission", !granted)

    fun notificationsEnabled(ctx: Context) =
        (Build.VERSION.SDK_INT < 33 || granted(ctx, Manifest.permission.POST_NOTIFICATIONS)) &&
            Notify.nm(ctx).areNotificationsEnabled()

    fun openSettings(ctx: Context, notifications: Boolean = false) {
        if (notifications && runCatching {
                ctx.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName))
            }.isSuccess) return
        runCatching {
            ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
        }
    }
}

@Composable
internal fun runtimeGrantAction(
    core: Core,
    ctx: Context,
    permissions: List<String>,
    notifications: Boolean = false,
    onResult: () -> Unit = {},
): Pair<String, () -> Unit> {
    val activity = LocalActivity.current
    val revision = remember { mutableIntStateOf(0) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
        results.forEach { (permission, granted) -> RuntimeGrant.record(core.store, permission, granted) }
        revision.intValue++
        if (notifications) core.taskAlerts.linkChanged()
        core.changed()
        onResult()
    }
    @Suppress("UNUSED_EXPRESSION") revision.intValue
    val request = activity?.let { RuntimeGrant.requestable(it, core.store, permissions) }.orEmpty()
    val action = {
        if (request.isEmpty()) RuntimeGrant.openSettings(ctx, notifications)
        else launcher.launch(request.toTypedArray())
    }
    return tr(if (request.isEmpty()) "Open Settings" else "Allow") to action
}
