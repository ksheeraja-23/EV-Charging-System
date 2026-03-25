// ================== IMPORTS ==================
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import db from "./db.js"; // ✅ only once
import bodyParser from "body-parser";

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// Serve static files (frontend)
app.use(express.static("public"));

// Simple request logger for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  if (['POST','PUT','PATCH'].includes(req.method)) {
    console.log('Body:', JSON.stringify(req.body));
  }
  next();
});


// ================== JWT Middleware ==================
const SECRET_KEY = "evion-secret";

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(" ")[1];
    jwt.verify(token, SECRET_KEY, (err, user) => {
      if (err) {
        return res.sendStatus(403);
      }
      req.user = user;
      next();
    });
  } else {
    next(); // allow unauthenticated for public routes
  }
}

// ================== AUTH ROUTES ==================
app.post("/api/register", (req, res) => {
  const { name, email, phone, password, address } = req.body;
  if (!email || !password) return res.status(400).json({ message: "Missing fields" });

  const sql = "INSERT INTO users (name, email, phone, password, address) VALUES (?, ?, ?, ?, ?)";
  db.query(sql, [name, email, phone, password, address], (err, result) => {
    if (err) {
      console.error("Register error:", err);
      return res.status(500).json({ message: "Registration failed" });
    }
    res.status(201).json({ userId: result.insertId });
  });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  db.query("SELECT * FROM users WHERE email = ? AND password = ?", [email, password], (err, results) => {
    if (err) return res.status(500).json({ message: "Login failed" });
    if (results.length === 0) return res.status(401).json({ message: "Invalid credentials" });

    const user = results[0];
    const token = jwt.sign({ user_id: user.user_id, role: user.role }, SECRET_KEY, { expiresIn: "2h" });
    res.json({ success: true, token, userId: user.user_id, role: user.role });
  });
});

// ================== USER ROUTES ==================
app.get("/api/users/:id", (req, res) => {
  const userId = req.params.id;
  db.query("SELECT * FROM users WHERE user_id = ?", [userId], (err, results) => {
    if (err) return res.status(500).json({ message: "Failed to fetch user" });
    if (results.length === 0) return res.status(404).json({ message: "User not found" });
    res.json(results[0]);
  });
});

app.get("/api/users/:id/stats", (req, res) => {
  const userId = req.params.id;
  const statsQuery = `
    SELECT 
      COUNT(DISTINCT b.booking_id) AS totalBookings,
      COALESCE(SUM(b.energy_consumed), 0) AS totalEnergy,
      COALESCE(SUM(b.amount_paid), 0) AS totalSavings
    FROM bookings b
    WHERE b.user_id = ?
  `;
  db.query(statsQuery, [userId], (err, results) => {
    if (err) return res.status(500).json({ message: "Error fetching stats" });
    res.json(results[0]);
  });
});

// ================== STATIONS ROUTE ==================
app.get("/api/stations", (req, res) => {
  db.query("SELECT * FROM stations", (err, results) => {
    if (err) return res.status(500).json({ message: "Failed to load stations" });
    res.json(results);
  });
});

// ================== VEHICLES ROUTE ==================
app.get("/api/vehicles/:userId", (req, res) => {
  const { userId } = req.params;
  db.query("SELECT * FROM vehicles WHERE user_id = ?", [userId], (err, results) => {
    if (err) return res.status(500).json({ message: "Failed to load vehicles" });
    res.json(results);
  });
});

app.post("/api/vehicles", (req, res) => {
  const { userId, vehicle_no, model, type, battery_capacity } = req.body;
  const sql = "INSERT INTO vehicles (user_id, vehicle_no, model, type, battery_capacity) VALUES (?, ?, ?, ?, ?)";
  db.query(sql, [userId, vehicle_no, model, type, battery_capacity], (err, result) => {
    if (err) return res.status(500).json({ message: "Failed to add vehicle" });
    res.status(201).json({ vehicleId: result.insertId });
  });
});

// ================== BOOKINGS ROUTE ==================
/**
 * POST /api/bookings
 * Body: { userId, stationId, slotId, vehicleId, bookingDate, startTime, endTime }
 * Returns: { bookingId } on success
 */
app.post('/api/bookings', (req, res) => {
  try {
    const { userId, stationId, slotId, vehicleId, bookingDate, startTime, endTime } = req.body;

    // ✅ Validation
    if (!userId || !stationId || !slotId || !vehicleId || !bookingDate || !startTime || !endTime) {
      return res.status(400).json({ message: 'Missing required booking fields' });
    }

    // ✅ Ensure endTime is after startTime
    if (startTime >= endTime) {
      return res.status(400).json({ message: 'End time must be after start time' });
    }

    // ✅ Prevent double-booking (time overlap on same date)
    const checkSql = `
      SELECT COUNT(*) AS cnt
      FROM bookings
      WHERE slot_id = ?
        AND booking_date = ?
        AND (
          (start_time <= ? AND end_time > ?)
          OR
          (start_time < ? AND end_time >= ?)
          OR
          (start_time >= ? AND end_time <= ?)
        )
        AND status <> 'cancelled'
    `;

    db.query(
      checkSql,
      [slotId, bookingDate, startTime, startTime, endTime, endTime, startTime, endTime],
      (chkErr, chkRes) => {
        if (chkErr) {
          console.error('Booking check error:', chkErr);
          return res.status(500).json({ message: 'Database error checking slot availability' });
        }

        if (chkRes[0].cnt > 0) {
          return res.status(409).json({ message: 'Slot already booked for this time range' });
        }

        // ✅ Insert booking (using correct columns)
        const insertSql = `
          INSERT INTO bookings 
          (user_id, station_id, slot_id, vehicle_id, booking_date, start_time, end_time, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', NOW())
        `;
        const params = [userId, stationId, slotId, vehicleId, bookingDate, startTime, endTime];

        db.query(insertSql, params, (insErr, insRes) => {
          if (insErr) {
            console.error('Booking insert error:', insErr);
            return res.status(500).json({ message: 'Failed to create booking' });
          }
          console.log(`✅ Booking created successfully (ID: ${insRes.insertId})`);
          res.status(201).json({ bookingId: insRes.insertId });
        });
      }
    );
  } catch (err) {
    console.error('Unexpected booking error:', err);
    res.status(500).json({ message: 'Unexpected server error' });
  }
});

/**
 * GET /api/bookings/:userId
 * Returns bookings for a user
 */
app.get('/api/bookings/:userId', (req, res) => {
  try {
    const userId = req.params.userId;
    const sql = `
      SELECT 
        b.booking_id,
        b.booking_date,
        b.start_time,
        b.end_time,
        b.status,
        s.station_name,
        v.model AS vehicle_model
      FROM bookings b
      LEFT JOIN stations s ON b.station_id = s.station_id
      LEFT JOIN vehicles v ON b.vehicle_id = v.vehicle_id
      WHERE b.user_id = ?
      ORDER BY b.booking_date DESC, b.start_time DESC
    `;
    db.query(sql, [userId], (err, results) => {
      if (err) {
        console.error('Bookings fetch error:', err);
        return res.status(500).json({ message: 'Failed to load bookings' });
      }
      res.json(results);
    });
  } catch (err) {
    console.error('Unexpected bookings GET error:', err);
    res.status(500).json({ message: 'Unexpected server error' });
  }
});



// ================== PAYMENTS ROUTE ==================
app.post("/api/payments", (req, res) => {
  const { bookingId, amount, paymentMethod, userId } = req.body;
  const sql = `
    INSERT INTO payments (booking_id, amount, payment_method, user_id, created_at)
    VALUES (?, ?, ?, ?, NOW())
  `;
  db.query(sql, [bookingId, amount, paymentMethod, userId], (err, result) => {
    if (err) {
      console.error("Payment insert error:", err);
      return res.status(500).json({ message: "Payment failed" });
    }
    res.status(201).json({ paymentId: result.insertId });
  });
});

app.get("/api/payments/:userId", (req, res) => {
  const { userId } = req.params;
  db.query("SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC", [userId], (err, results) => {
    if (err) return res.status(500).json({ message: "Failed to load payments" });
    res.json(results);
  });
});

// ================== FEEDBACK ROUTES ==================
app.post("/api/feedback", (req, res) => {
  const { rating, comment, isComplaint, pumpIdentifier, bookingId, paymentId } = req.body;
  const userId = req.user?.user_id || 1; // fallback for dev

  if (!rating || !comment) {
    return res.status(400).json({ message: "Rating and comment are required" });
  }

  const sql = `
    INSERT INTO feedback (user_id, rating, comment, is_complaint, pump_identifier, booking_id, payment_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
  `;
  const values = [userId, rating, comment, isComplaint ? 1 : 0, pumpIdentifier, bookingId || null, paymentId || null];

  db.query(sql, values, (err, result) => {
    if (err) {
      console.error("❌ Feedback insert error:", err);
      return res.status(500).json({ message: "Database error while submitting feedback" });
    }
    res.status(201).json({ success: true, feedbackId: result.insertId });
  });
});

app.get("/api/feedback", (req, res) => {
  const sql = `
    SELECT f.*, u.name AS user_name 
    FROM feedback f 
    LEFT JOIN users u ON f.user_id = u.user_id 
    ORDER BY f.created_at DESC
  `;
  db.query(sql, (err, results) => {
    if (err) {
      console.error("❌ Feedback fetch error:", err);
      return res.status(500).json({ message: "Database error while loading feedback" });
    }
    res.json(results);
  });
});

// ================== START SERVER ==================
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
