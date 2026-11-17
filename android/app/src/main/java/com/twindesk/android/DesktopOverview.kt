// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// Displays & desktops sheet for the Mac viewer. A tile shows the still preview the Mac
// sent for that desktop during this session, or says it has not been previewed. It is
// not a live picture and it does not invent windows.
package com.twindesk.android

import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Sheet = Color(0xE81B1E25)
private val Ink = Color(0xFFF5F6FB)
private val Muted = Color(0xFFAEB5C4)
private val Line = Color.White.copy(alpha = 0.13f)
private val Selected = Color(0xFFA7C9FF)
private val Viewing = Color(0xFFC0D9FF)

@Composable
fun DesktopOverview(
    catalog: DesktopSelect.Catalog,
    pendingDisplayId: String,
    note: String,
    mode: String,
    sharing: Boolean,
    remote: Boolean,
    reduceMotion: Boolean,
    previews: DesktopPreview.Board,
    spaceHold: String,
    onDone: () -> Unit,
    onDesktop: (String, String) -> Unit,
    onDisplay: (String) -> Unit,
    onMode: (String) -> Unit,
) {
    BackHandler(onBack = onDone)
    val scrim = remember { MutableInteractionSource() }
    var arrived by remember { mutableStateOf(reduceMotion) }
    LaunchedEffect(Unit) { arrived = true }
    val alpha by animateFloatAsState(if (arrived) 1f else 0f, tween(if (reduceMotion) 0 else 220, easing = FastOutSlowInEasing), label = "sheet")
    val offset by animateFloatAsState(if (arrived || reduceMotion) 0f else 28f, tween(if (reduceMotion) 0 else 220, easing = FastOutSlowInEasing), label = "sheetMove")
    Box(Modifier.fillMaxSize()) {
        // Keep a tap here from reaching the Mac. Done is what closes the sheet.
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.28f)).clickable(scrim, null) {})
        BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
            val wide = maxWidth >= 580.dp
            val deskCols = when {
                maxWidth < 400.dp -> 3
                maxWidth < 600.dp -> 4
                else -> 6
            }
            val tileHeight = when {
                maxWidth < 400.dp -> 56.dp
                maxWidth < 600.dp -> 72.dp
                else -> 90.dp
            }
            val side = if (wide) 24.dp else 8.dp
            val listMax = (maxHeight - 188.dp).coerceAtLeast(120.dp)
            Column(
                Modifier
                    .padding(start = side, end = side, bottom = side)
                    .widthIn(max = 720.dp)
                    .fillMaxWidth()
                    .heightIn(max = maxHeight - 16.dp)
                    .graphicsLayer { this.alpha = alpha; translationY = offset }
                    .clip(RoundedCornerShape(26.dp))
                    .background(Sheet)
                    .border(1.dp, Color.White.copy(alpha = 0.13f), RoundedCornerShape(26.dp))
                    .padding(horizontal = if (wide) 20.dp else 16.dp, vertical = if (wide) 16.dp else 12.dp),
            ) {
                Box(Modifier.padding(bottom = 12.dp).size(width = 36.dp, height = 4.dp).clip(RoundedCornerShape(4.dp)).background(Color.White.copy(alpha = 0.33f)).align(Alignment.CenterHorizontally))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            tr("Displays & desktops"),
                            color = Ink,
                            fontSize = 21.sp,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.semantics { heading() },
                        )
                        Text(tr("Choose where you want to work"), color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                        val previewNote = when (previews.unavailable) {
                            "os" -> tr("Desktop previews need macOS 14.")
                            "permission" -> tr("Desktop previews need Screen Recording.")
                            else -> ""
                        }
                        if (previewNote.isNotEmpty()) Text(previewNote, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
                    }
                    val done = tr("Done")
                    Text(
                        done,
                        color = Ink,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                            .clip(RoundedCornerShape(14.dp))
                            .background(Color.White.copy(alpha = 0.08f))
                            .clickable(onClick = onDone, role = Role.Button)
                            .padding(horizontal = 14.dp, vertical = 12.dp)
                            .clearAndSetSemantics { role = Role.Button; contentDescription = done },
                    )
                }
                Column(Modifier.padding(top = 8.dp).heightIn(max = listMax).verticalScroll(rememberScrollState())) {
                    DisplayGrid(catalog, pendingDisplayId, onDisplay)
                    catalog.displays.forEachIndexed { index, display ->
                        val label = display.name.ifBlank { tr("This screen") }
                        Row(Modifier.fillMaxWidth().padding(top = 15.dp, bottom = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.Bottom) {
                            Text(tr("Desktops on {name}", "name" to label), color = Ink, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(if (display.count == 1) tr("1 desktop") else tr("{count} desktops", "count" to display.count), color = Muted, fontSize = 11.sp)
                        }
                        DesktopGrid(display, catalog.viewing, deskCols, tileHeight, reduceMotion, previews, spaceHold, onDesktop)
                        if (display.truncated) Text(tr("More desktops are on this Mac than this list shows"), color = Muted, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp))
                        if (index == catalog.displays.lastIndex) Spacer(Modifier.height(4.dp))
                    }
                }
                Row(
                    Modifier.fillMaxWidth().padding(top = 12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (remote) ModeSwitch(mode, sharing, onMode)
                    else Spacer(Modifier.widthIn(min = 48.dp))
                    Text(
                        note.ifBlank { tr("Tap a desktop to switch") },
                        color = Muted,
                        fontSize = 11.sp,
                        modifier = Modifier.padding(start = 12.dp).weight(1f),
                        textAlign = androidx.compose.ui.text.style.TextAlign.End,
                    )
                }
            }
        }
    }
}

@Composable
private fun DisplayGrid(catalog: DesktopSelect.Catalog, pendingDisplayId: String, onDisplay: (String) -> Unit) {
    val rows = catalog.displays.chunked(2)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (row in rows) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (display in row) {
                    val position = catalog.displays.indexOf(display) + 1
                    val label = display.name.ifBlank { tr("This screen") }
                    val viewing = display.id == catalog.viewing
                    val switching = !viewing && display.id == pendingDisplayId
                    val highlighted = viewing || switching
                    val status = if (viewing) tr("Viewing") else if (switching) tr("Switching") else ""
                    val subtitle = if (display.primary) tr("Main display") else tr("Display {n}", "n" to position)
                    val description = buildString {
                        append(label).append(", ").append(subtitle)
                        if (status.isNotEmpty()) append(", ").append(status)
                    }
                    val press = remember { MutableInteractionSource() }
                    Column(
                        Modifier
                            .weight(1f)
                            .defaultMinSize(minHeight = 72.dp)
                            .clip(RoundedCornerShape(16.dp))
                            .background(if (highlighted) Color.White.copy(alpha = 0.09f) else Color.White.copy(alpha = 0.04f))
                            .border(1.dp, if (highlighted) Selected else Line, RoundedCornerShape(16.dp))
                            .clickable(interactionSource = press, indication = null, role = Role.Button) { onDisplay(display.id) }
                            .padding(12.dp)
                            .clearAndSetSemantics {
                                role = Role.Button
                                selected = viewing
                                contentDescription = description
                            },
                    ) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            MonitorGlyph()
                            Text(
                                status,
                                color = Viewing,
                                fontSize = 10.sp,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = androidx.compose.ui.text.style.TextAlign.End,
                                modifier = Modifier.padding(start = 8.dp).weight(1f),
                            )
                        }
                        Text(label, color = Ink, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                        Text(subtitle, color = Muted, fontSize = 11.sp, modifier = Modifier.padding(top = 3.dp))
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun DesktopGrid(
    display: DesktopSelect.Display,
    viewingId: String,
    cols: Int,
    tileHeight: androidx.compose.ui.unit.Dp,
    reduceMotion: Boolean,
    previews: DesktopPreview.Board,
    spaceHold: String,
    onDesktop: (String, String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        for (row in display.desktops.chunked(cols)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                for (desk in row) {
                    DesktopTile(display, desk, viewingId, tileHeight, reduceMotion, previews, spaceHold, Modifier.weight(1f), onDesktop)
                }
                repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun DesktopTile(
    display: DesktopSelect.Display,
    desk: DesktopSelect.Desk,
    viewingId: String,
    tileHeight: androidx.compose.ui.unit.Dp,
    reduceMotion: Boolean,
    previews: DesktopPreview.Board,
    spaceHold: String,
    modifier: Modifier,
    onDesktop: (String, String) -> Unit,
) {
    val marked = desk.current
    val viewingThis = marked && display.id == viewingId
    val held = spaceHold == "overview" || spaceHold == "accessibility"
    val shot = previews.shots.find { it.displayId == display.id && it.spaceId == desk.id }
    val bitmap = remember(shot?.seq) {
        val bytes = shot?.jpeg
        if (bytes == null) null
        else runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull()
    }
    val status = DesktopPreview.tile(previews, display.id, desk, held)
    val shown = if (bitmap == null) DesktopPreview.Status.NONE else status
    val statusText = when (shown) {
        DesktopPreview.Status.CURRENT -> tr("Current preview")
        DesktopPreview.Status.LAST -> tr("Last seen this session")
        DesktopPreview.Status.NONE -> tr("Not previewed yet")
    }
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed && !reduceMotion) 0.97f else 1f, tween(if (reduceMotion) 0 else 160, easing = FastOutSlowInEasing), label = "press")
    val description = buildString {
        append(tr("Desktop {n}", "n" to desk.index + 1))
        if (viewingThis) append(", ").append(tr("Viewing"))
        append(", ").append(statusText)
    }
    Column(
        modifier
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .defaultMinSize(minHeight = 48.dp)
            .clickable(interactionSource = source, indication = null, enabled = desk.selectable, role = Role.Button) {
                onDesktop(display.id, desk.id)
            }
            .clearAndSetSemantics {
                role = Role.Button
                selected = marked
                contentDescription = description
            },
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(tileHeight)
                .clip(RoundedCornerShape(10.dp))
                .background(Color(0xFF232833))
                .border(if (marked) 2.dp else 1.dp, if (marked) Color(0xFFB2D1FF) else Color.White.copy(alpha = 0.15f), RoundedCornerShape(10.dp)),
        ) {
            if (bitmap != null) Image(bitmap.asImageBitmap(), contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        }
        Row(Modifier.padding(top = 7.dp), verticalAlignment = Alignment.CenterVertically) {
            if (marked) Box(Modifier.padding(end = 4.dp).size(5.dp).clip(RoundedCornerShape(3.dp)).background(Color(0xFF9BC7FF)))
            Text(
                tr("Desktop {n}", "n" to desk.index + 1),
                color = if (marked) Color.White else Color(0xFFD7DBE5),
                fontSize = 11.sp,
                fontWeight = if (marked) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Text(statusText, color = Ink, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
    }
}

@Composable
private fun ModeSwitch(mode: String, sharing: Boolean, onMode: (String) -> Unit) {
    Row(Modifier.clip(RoundedCornerShape(13.dp)).background(Color.Black.copy(alpha = 0.25f)).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        for (item in listOf("mirror", "extend")) {
            val on = sharing && (mode == item || (item == "mirror" && mode == "custom"))
            val label = if (item == "mirror") tr("Mirror") else tr("Extend")
            Text(
                label,
                color = if (on) Color.White else Color(0xFFBDC3CE),
                fontSize = 12.sp,
                fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier
                    .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (on) Color.White.copy(alpha = 0.13f) else Color.Transparent)
                    .clickable(enabled = !on, role = Role.Button) { onMode(item) }
                    .padding(horizontal = 14.dp, vertical = 12.dp)
                    .clearAndSetSemantics {
                        role = Role.Button
                        selected = on
                        contentDescription = label
                    },
            )
        }
    }
}

@Composable
private fun MonitorGlyph() {
    androidx.compose.foundation.Canvas(Modifier.size(width = 22.dp, height = 17.dp)) {
        val stroke = 1.6.dp.toPx()
        drawRoundRect(
            color = Color(0xFFD5DBE7),
            topLeft = androidx.compose.ui.geometry.Offset(stroke, stroke),
            size = androidx.compose.ui.geometry.Size(size.width - stroke * 2, size.height * 0.68f),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(3.dp.toPx(), 3.dp.toPx()),
            style = androidx.compose.ui.graphics.drawscope.Stroke(stroke),
        )
        drawLine(Color(0xFFD5DBE7), androidx.compose.ui.geometry.Offset(size.width / 2, size.height * 0.72f), androidx.compose.ui.geometry.Offset(size.width / 2, size.height * 0.9f), stroke)
        drawLine(Color(0xFFD5DBE7), androidx.compose.ui.geometry.Offset(size.width * 0.32f, size.height * 0.9f), androidx.compose.ui.geometry.Offset(size.width * 0.68f, size.height * 0.9f), stroke)
    }
}
