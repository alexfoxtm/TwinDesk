package com.twindesk.android

import android.content.ComponentCallbacks2

internal const val DECK_ICON_CACHE_MAX = 48

/**
 * Least-recently-used icon bytes. The eldest entry goes once the cap is passed.
 * Access-order reads mutate the map, so every call takes the same lock as a trim.
 */
internal class BoundedIconCache<V>(private val max: Int = DECK_ICON_CACHE_MAX) {
    private val map = object : LinkedHashMap<String, V>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, V>?) = size > max
    }

    fun getOrPut(key: String, create: () -> V): V = synchronized(map) {
        if (map.containsKey(key)) {
            @Suppress("UNCHECKED_CAST")
            return map.get(key) as V
        }
        val value = create()
        map[key] = value
        value
    }

    fun clear() = synchronized(map) { map.clear() }

    val size get() = synchronized(map) { map.size }

    operator fun set(key: String, value: V) {
        synchronized(map) { map[key] = value }
    }

    operator fun get(key: String): V? = synchronized(map) {
        if (!map.containsKey(key)) return null
        @Suppress("UNCHECKED_CAST")
        map.get(key) as V
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

/**
 * What a phone-wide trim may drop. The app list is built only if a page already did.
 * Icons the computer sent with notifications are not here: it sends each one once a session.
 */
internal fun registerPhoneRebuildableCaches(
    deck: () -> Unit,
    appList: Lazy<*>,
    appListDrop: () -> Unit,
    rezume: () -> Unit,
): () -> Unit = RebuildableCaches.register {
    deck()
    if (appList.isInitialized()) appListDrop()
    rezume()
}
