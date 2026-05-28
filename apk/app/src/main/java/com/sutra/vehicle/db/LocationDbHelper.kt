package com.sutra.vehicle.db

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.sutra.vehicle.data.VehicleUpdatePayload

class LocationDbHelper(context: Context) : SQLiteOpenHelper(context, DATABASE_NAME, null, DATABASE_VERSION) {

    companion object {
        private const val DATABASE_NAME = "telemetry_history.db"
        private const val DATABASE_VERSION = 1

        private const val TABLE_NAME = "location_history"
        private const val COLUMN_ID = "id"
        private const val COLUMN_LAT = "latitude"
        private const val COLUMN_LNG = "longitude"
        private const val COLUMN_SPEED = "speed"
        private const val COLUMN_BEARING = "bearing"
        private const val COLUMN_TIMESTAMP = "timestamp"
        private const val COLUMN_EMERGENCY = "is_emergency"
        private const val COLUMN_VEHICLE_ID = "vehicle_id"
        private const val COLUMN_DRIVER_NAME = "driver_name"
        private const val COLUMN_VEHICLE_TYPE = "vehicle_type"
    }

    override fun onCreate(db: SQLiteDatabase) {
        val createTableQuery = ("CREATE TABLE $TABLE_NAME (" +
                "$COLUMN_ID INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "$COLUMN_VEHICLE_ID TEXT, " +
                "$COLUMN_DRIVER_NAME TEXT, " +
                "$COLUMN_VEHICLE_TYPE TEXT, " +
                "$COLUMN_LAT REAL, " +
                "$COLUMN_LNG REAL, " +
                "$COLUMN_SPEED REAL, " +
                "$COLUMN_BEARING REAL, " +
                "$COLUMN_TIMESTAMP INTEGER, " +
                "$COLUMN_EMERGENCY INTEGER)")
        db.execSQL(createTableQuery)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS $TABLE_NAME")
        onCreate(db)
    }

    fun insertLocation(payload: VehicleUpdatePayload) {
        val db = this.writableDatabase
        val values = ContentValues().apply {
            put(COLUMN_VEHICLE_ID, payload.vehicleId)
            put(COLUMN_DRIVER_NAME, payload.driverName)
            put(COLUMN_VEHICLE_TYPE, payload.type)
            put(COLUMN_LAT, payload.lat)
            put(COLUMN_LNG, payload.lng)
            put(COLUMN_SPEED, payload.speed)
            put(COLUMN_BEARING, payload.direction)
            put(COLUMN_TIMESTAMP, payload.timestamp)
            put(COLUMN_EMERGENCY, if (payload.isEmergency) 1 else 0)
        }
        db.insert(TABLE_NAME, null, values)
        db.close()
    }

    fun getAllHistory(): List<VehicleUpdatePayload> {
        val historyList = mutableListOf<VehicleUpdatePayload>()
        val db = this.readableDatabase
        val cursor = db.rawQuery("SELECT * FROM $TABLE_NAME ORDER BY $COLUMN_TIMESTAMP ASC", null)

        if (cursor.moveToFirst()) {
            do {
                val vehicleId = cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_VEHICLE_ID))
                val driverName = cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_DRIVER_NAME))
                val type = cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_VEHICLE_TYPE))
                val lat = cursor.getDouble(cursor.getColumnIndexOrThrow(COLUMN_LAT))
                val lng = cursor.getDouble(cursor.getColumnIndexOrThrow(COLUMN_LNG))
                val speed = cursor.getFloat(cursor.getColumnIndexOrThrow(COLUMN_SPEED))
                val bearing = cursor.getFloat(cursor.getColumnIndexOrThrow(COLUMN_BEARING))
                val timestamp = cursor.getLong(cursor.getColumnIndexOrThrow(COLUMN_TIMESTAMP))
                val isEmergency = cursor.getInt(cursor.getColumnIndexOrThrow(COLUMN_EMERGENCY)) == 1

                historyList.add(
                    VehicleUpdatePayload(
                        vehicleId = vehicleId,
                        driverName = driverName,
                        type = type,
                        lat = lat,
                        lng = lng,
                        speed = speed,
                        direction = bearing,
                        timestamp = timestamp,
                        isEmergency = isEmergency
                    )
                )
            } while (cursor.moveToNext())
        }
        cursor.close()
        db.close()
        return historyList
    }

    fun clearHistory() {
        val db = this.writableDatabase
        db.execSQL("DELETE FROM $TABLE_NAME")
        db.close()
    }
}
