// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// phone.in 'z' compatibility. Keep in step with shared/pinchwire.js.
//   input.pinch         fork c49da681 only: normalized x,y plus v. An old Mac sends that when it
//                       sees this name. It does not mean the pixel stroke.
//   input.pinch.stroke  this app also understands upstream's pixel x,y plus from,to,vert. Advertised
//                       beside input.pinch so that old Mac still sends legacy.
//   neither             upstream Android: pixel stroke, and it advertises no pinch capability.
package com.twindesk.android

import kotlin.math.exp
import kotlin.math.max

internal object PinchWire {
    const val CAP_LEGACY = "input.pinch"
    const val CAP_STROKE = "input.pinch.stroke"

    enum class Dialect { LEGACY, STROKE }
    enum class Kind { LEGACY, STROKE, REJECT }

    fun caps(accessibility: Boolean): List<String> =
        if (accessibility) listOf(CAP_LEGACY, CAP_STROKE) else emptyList()

    fun dialect(caps: Collection<String>?): Dialect {
        val names = caps?.filter { it.isNotEmpty() }?.take(50)?.toSet() ?: emptySet()
        if (CAP_STROKE in names) return Dialect.STROKE
        if (CAP_LEGACY in names) return Dialect.LEGACY
        return Dialect.STROKE
    }

    // Field presence only. A small x,y is not a legacy pinch, and v together with from/to is neither.
    fun kind(hasFrom: Boolean, hasTo: Boolean, hasVert: Boolean, hasV: Boolean): Kind {
        val stroke = hasFrom || hasTo || hasVert
        if (stroke && hasV) return Kind.REJECT
        if (hasFrom && hasTo) return Kind.STROKE
        if (hasV && !stroke) return Kind.LEGACY
        return Kind.REJECT
    }
}

// The fork phone's own finger placement (c49da681 InputService.pinch), so a legacy message zooms
// the same way that build did. Null means there is no stroke to dispatch.
internal data class LegacyFingers(
    val x: Float,
    val y: Float,
    val start: Float,
    val end: Float,
    val horizontal: Boolean,
)

internal fun legacyFingers(
    nx: Double,
    ny: Double,
    amount: Double,
    widthPx: Float,
    heightPx: Float,
    density: Float,
    densityDpi: Int,
): LegacyFingers? {
    if (!nx.isFinite() || !ny.isFinite() || !amount.isFinite() || amount == 0.0) return null
    if (widthPx <= 0f || heightPx <= 0f || densityDpi <= 0) return null
    val margin = max(8f, density * 48f)
    val horizontal = widthPx >= heightPx
    val length = if (horizontal) widthPx else heightPx
    val cross = if (horizontal) heightPx else widthPx
    val minSpan = densityDpi * 0.6f
    val maxSpan = minOf((length - 2 * margin - 2) / 2, length * 0.3f, densityDpi * 1.6f)
    if (minSpan >= maxSpan || cross <= 2 * margin) return null
    val start = if (amount > 0) minSpan else maxSpan
    val end = (start * exp(amount.coerceIn(-1.0, 1.0) * 1.6)).toFloat().coerceIn(minSpan, maxSpan)
    val along = (if (horizontal) nx.toFloat() * widthPx else ny.toFloat() * heightPx)
        .coerceIn(margin + maxSpan, length - 1 - margin - maxSpan)
    val across = (if (horizontal) ny.toFloat() * heightPx else nx.toFloat() * widthPx)
        .coerceIn(margin, cross - 1 - margin)
    val x = if (horizontal) along else across
    val y = if (horizontal) across else along
    return LegacyFingers(x, y, start, end, horizontal)
}
