package com.twindesk.android

import android.content.ComponentCallbacks2

internal const val DECK_ICON_CACHE_MAX = 48

/** Least-recently-used icon bytes. The eldest entry goes once the cap is passed. */
internal class BoundedIconCache<V>(private val max: Int = DECK_ICON_CACHE_MAX) {
    private val map = object : LinkedHashMap<String, V>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, V>?) = size > max
    }

    fun getOrPut(key: String, create: () -> V): V {
        if (map.containsKey(key)) {
            @Suppress("UNCHECKED_CAST")
            return map.get(key) as V
        }
        val value = create()
        map[key] = value
        return value
    }

    fun clear() = map.clear()

    val size get() = map.size

    operator fun set(key: String, value: V) {
        map[key] = value
    }

    operator fun get(key: String): V? {
        if (!map.containsKey(key)) return null
        @Suppress("UNCHECKED_CAST")
        return map.get(key) as V
    }
}

/** Background and low-memory trim, including while the app is still on screen but not critical yet. */
@Suppress("DEPRECATION")
internal fun shouldReleaseCaches(level: Int): Boolean = level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE

/** Caches that can be built again. A composition registers its own drop and unregisters when it leaves. */
internal object RebuildableCaches {
    private val drops = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    fun register(drop: () -> Unit): () -> Unit {
        drops.add(drop)
        return {
            drops.remove(drop)
        }
    }

    fun trim(level: Int) {
        if (!shouldReleaseCaches(level)) return
        for (drop in drops) runCatching { drop() }
    }

    fun clearForTest() = drops.clear()
}
