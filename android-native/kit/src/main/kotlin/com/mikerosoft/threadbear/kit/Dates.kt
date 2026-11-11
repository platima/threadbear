package com.mikerosoft.threadbear.kit

import java.time.Instant
import java.time.OffsetDateTime
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Dates in Convex rows (FlexibleDate.swift): milliseconds, as Convex code
 * stores them, or ISO strings, as the runner writes them. Held to
 * JavaScript's own range, so one thread's bad date can't break the inbox.
 */
object FlexibleDate {
    private const val LIMIT = 8.64e15

    fun read(value: JsonElement?): Instant? {
        val p = value as? JsonPrimitive ?: return null
        if (!p.isString) {
            val ms = p.doubleOrNull ?: return null
            if (!ms.isFinite()) return null
            return Instant.ofEpochMilli(ms.coerceIn(-LIMIT, LIMIT).toLong())
        }
        return parseIso(p.content)
    }

    fun parseIso(text: String): Instant? =
        try {
            Instant.parse(text)
        } catch (_: Exception) {
            try {
                OffsetDateTime.parse(text).toInstant()
            } catch (_: Exception) {
                null
            }
        }
}

fun JsonObject.date(key: String): Instant? = FlexibleDate.read(this[key])
fun JsonObject.needDate(key: String): Instant = date(key) ?: throw BadRow("No date $key")
