-- Initial schema for EVion (creates tables if they do not exist)

CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(20),
  password VARCHAR(255) NOT NULL,
  address VARCHAR(255),
  avatar VARCHAR(255),
  role VARCHAR(50) DEFAULT 'Member',
  vehicle_no VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stations (
  station_id INT AUTO_INCREMENT PRIMARY KEY,
  station_name VARCHAR(255) NOT NULL,
  address VARCHAR(255),
  contact_no VARCHAR(50),
  location VARCHAR(100),
  image VARCHAR(512),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slots (
  slot_id INT AUTO_INCREMENT PRIMARY KEY,
  station_id INT,
  slot_number VARCHAR(50),
  status ENUM('available','booked','maintenance') DEFAULT 'available',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (station_id) REFERENCES stations(station_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  vehicle_no VARCHAR(50),
  model VARCHAR(150),
  type VARCHAR(50),
  battery_capacity VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bookings (
  booking_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  vehicle_id INT, -- Added/Confirmed
  slot_id INT,
  booking_date DATE,
  start_time TIME,
  end_time TIME,
  status ENUM('pending','confirmed','cancelled','completed') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id) ON DELETE SET NULL,
  FOREIGN KEY (slot_id) REFERENCES slots(slot_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payments (
  payment_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  booking_id INT,
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(100),
  transaction_id VARCHAR(255) UNIQUE,
  payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status ENUM('pending','success','failed') DEFAULT 'success',
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  FOREIGN KEY (booking_id) REFERENCES bookings(booking_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  feedback_id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT,
  station_id INT,
  rating INT,
  comment TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  FOREIGN KEY (station_id) REFERENCES stations(station_id) ON DELETE SET NULL
);

-- Charger usage log as provided
CREATE TABLE IF NOT EXISTS charger_usage_log (
    log_id INT AUTO_INCREMENT PRIMARY KEY,
    slot_id INT,
    station_id INT,
    user_id INT,
    booking_id INT,
    start_time DATETIME,
    end_time DATETIME,
    status ENUM('in_use', 'completed') DEFAULT 'in_use',
    FOREIGN KEY (slot_id) REFERENCES slots(slot_id) ON DELETE SET NULL,
    FOREIGN KEY (station_id) REFERENCES stations(station_id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    FOREIGN KEY (booking_id) REFERENCES bookings(booking_id) ON DELETE SET NULL
);

-- Stored procedure: create_booking (adapted)
DROP PROCEDURE IF EXISTS create_booking;
DELIMITER $$
CREATE PROCEDURE create_booking(
    IN p_user_id INT,
    IN p_vehicle_id INT,
    IN p_slot_id INT,
    IN p_booking_date DATE,
    IN p_start_time TIME,
    IN p_end_time TIME
)
BEGIN
    DECLARE v_station_id INT;

    SELECT station_id INTO v_station_id FROM slots WHERE slot_id = p_slot_id;

    IF (SELECT status FROM slots WHERE slot_id = p_slot_id) = 'available' THEN
        INSERT INTO bookings (user_id, vehicle_id, slot_id, booking_date, start_time, end_time, status)
        VALUES (p_user_id, p_vehicle_id, p_slot_id, p_booking_date, p_start_time, p_end_time, 'confirmed');

        UPDATE slots SET status = 'booked' WHERE slot_id = p_slot_id;

        INSERT INTO charger_usage_log (slot_id, station_id, user_id, booking_id, start_time, end_time, status)
        VALUES (p_slot_id, v_station_id, p_user_id, LAST_INSERT_ID(), NOW(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'in_use');
    ELSE
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Slot is not available for booking';
    END IF;
END $$
DELIMITER ;

-- Trigger before inserting into bookings
DROP TRIGGER IF EXISTS trg_before_booking_insert;
DELIMITER $$
CREATE TRIGGER trg_before_booking_insert
BEFORE INSERT ON bookings
FOR EACH ROW
BEGIN
    DECLARE v_status ENUM('available','booked','maintenance');
    SELECT status INTO v_status FROM slots WHERE slot_id = NEW.slot_id;
    IF v_status <> 'available' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Slot is already booked or under maintenance.';
    END IF;
END $$
DELIMITER ;

-- Trigger after insert on bookings
DROP TRIGGER IF EXISTS trg_after_booking_insert;
DELIMITER $$
CREATE TRIGGER trg_after_booking_insert
AFTER INSERT ON bookings
FOR EACH ROW
BEGIN
    DECLARE v_station_id INT;
    SELECT station_id INTO v_station_id FROM slots WHERE slot_id = NEW.slot_id;
    UPDATE slots SET status = 'booked' WHERE slot_id = NEW.slot_id;
    INSERT INTO charger_usage_log (slot_id, station_id, user_id, booking_id, start_time, end_time, status)
    VALUES (NEW.slot_id, v_station_id, NEW.user_id, NEW.booking_id, NOW(), DATE_ADD(NOW(), INTERVAL 10 MINUTE), 'in_use');
END $$
DELIMITER ;


DROP PROCEDURE IF EXISTS create_booking;
DELIMITER $$
CREATE PROCEDURE create_booking(
    IN p_user_id INT,
    IN p_vehicle_id INT,
    IN p_slot_id INT,
    IN p_booking_date DATE,
    IN p_start_time TIME,
    IN p_end_time TIME
)
BEGIN
    -- Check if the slot is still 'available' before inserting
    DECLARE v_slot_status ENUM('available','booked','maintenance');
    SELECT status INTO v_slot_status FROM slots WHERE slot_id = p_slot_id;

    IF v_slot_status = 'available' THEN
        -- 1. Insert the booking with initial 'pending' status
        INSERT INTO bookings (user_id, vehicle_id, slot_id, booking_date, start_time, end_time, status)
        VALUES (p_user_id, p_vehicle_id, p_slot_id, p_booking_date, p_start_time, p_end_time, 'pending');

        -- 2. Return the new booking_id
        SELECT LAST_INSERT_ID() AS bookingId;
    ELSE
        -- Signal an error if the slot is no longer available
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Slot is not available for booking';
    END IF;
END $$
DELIMITER ;

-- End of schema
