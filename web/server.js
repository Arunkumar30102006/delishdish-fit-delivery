require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto'); // Needed for password generation
const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.JWT_SECRET || 'Ak@30102006'; // Use JWT_SECRET from .env

app.use(cors());
app.use(bodyParser.json());
// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
// Serve images specifically if needed (optional if images are in public/images)
app.use('/image', express.static(path.join(__dirname, 'image')));


// Serve index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve delivery.html
app.get('/delivery.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'delivery.html'));
});

// Serve admin.html
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});


// MySQL pool
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'food_order_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Add timezone if needed, e.g., for consistent DATETIME storage
    // timezone: '+05:30' // Example for IST
});

// Test DB connection
pool.getConnection()
    .then(connection => {
        console.log('✅ Successfully connected to the MySQL database!');
        connection.release();
    })
    .catch(err => {
        console.error('❌ Failed to connect to the database:', err.stack || err);
        // Exit process if DB connection fails on startup
        process.exit(1);
    });

// ============================================
// MIDDLEWARE
// ============================================

// General Authentication Middleware
const authenticateUser = (req, res, next) => {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

    if (!token) {
        console.log('Auth Middleware: No token provided');
        return res.status(401).json({ message: 'No token provided.' });
    }

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) {
            console.log('Auth Middleware: Invalid token:', err.message);
            return res.status(403).json({ message: 'Invalid or expired token.' });
        }
        // console.log('Auth Middleware: Token verified for user ID:', user.id, 'Role:', user.role);
        req.user = user; // Attach user payload (id, role) to the request
        next();
    });
};

// Admin Authentication Middleware
const authenticateAdmin = (req, res, next) => {
    authenticateUser(req, res, () => { // Run general auth first
        if (req.user && req.user.role === 'admin') {
            // console.log('Admin Auth: Access granted for user ID:', req.user.id);
            next(); // User is authenticated and is an admin
        } else {
            console.log('Admin Auth: Access denied. User ID:', req.user ? req.user.id : 'N/A', 'Role:', req.user ? req.user.role : 'N/A');
            res.status(403).json({ message: 'Access denied. Admin role required.' });
        }
    });
};

// Delivery Partner Authentication Middleware
const authenticateDelivery = (req, res, next) => {
    authenticateUser(req, res, () => { // Run general auth first
        if (req.user && req.user.role === 'delivery') {
            // console.log('Delivery Auth: Access granted for user ID:', req.user.id);
            next(); // User is authenticated and is a delivery partner
        } else {
            console.log('Delivery Auth: Access denied. User ID:', req.user ? req.user.id : 'N/A', 'Role:', req.user ? req.user.role : 'N/A');
            res.status(403).json({ message: 'Access denied. Delivery role required.' });
        }
    });
};

// ====================================================================
// UTILITY FUNCTIONS
// ====================================================================

// Safely Parse JSON columns from DB
const parseJsonColumns = (item) => {
    let ingredientsArray = [];
    let nutritionObject = {};

    if (item.ingredients) {
        try {
            ingredientsArray = JSON.parse(item.ingredients);
            if (!Array.isArray(ingredientsArray)) throw new Error();
        } catch (e) {
            // console.warn(`Ingredient parse failed for item ${item.id}. Fallback.`);
            let cleanStr = String(item.ingredients).replace(/\[|\]|"/g, '').trim();
            ingredientsArray = cleanStr.split(',').map(s => s.trim()).filter(Boolean);
        }
    }

    if (item.nutrition) {
        try {
            nutritionObject = JSON.parse(item.nutrition);
            if (typeof nutritionObject !== 'object' || Array.isArray(nutritionObject) || nutritionObject === null) throw new Error();
        } catch (e) {
            // console.warn(`Nutrition parse failed for item ${item.id}. Empty obj.`);
            nutritionObject = {};
        }
    }

    // Ensure price is a number
    const price = item.price !== null && item.price !== undefined ? parseFloat(item.price) : 0.00;


    return {
        ...item,
        price, // Return price as a number
        ingredients: ingredientsArray,
        nutrition: nutritionObject
    };
};

// Format orders array, including fetching items
async function formatOrders(rows) {
    if (!rows || rows.length === 0) {
        return [];
    }
    const formatted = await Promise.all(rows.map(async (order) => {
        try {
            const [itemsRows] = await pool.query(
                `SELECT oi.menu_item_id, oi.quantity, oi.price, mi.name
                 FROM order_items oi
                 LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
                 WHERE oi.order_id = ?`,
                [order.id]
            );

            let cartItems = itemsRows.map(it => ({
                id: it.menu_item_id,
                name: it.name || 'Item Not Found', // Handle missing item name
                quantity: it.quantity,
                price: parseFloat(it.price) // Price stored in order_items
            }));

            // Recalculate total price from items fetched (safer than relying on potentially stale order_details JSON)
            const calculatedTotalPrice = cartItems.reduce((sum, it) => sum + (it.price * it.quantity), 0);

            // Parse order_details JSON if it exists, otherwise use empty array
            let parsedOrderDetails = [];
            if (order.order_details) {
                try {
                    parsedOrderDetails = JSON.parse(order.order_details);
                } catch(e) {
                    console.error(`Failed to parse order_details JSON for order ${order.id}`);
                }
            }


            return {
                orderId: order.id,
                userId: order.user_id,
                deliveryPartnerId: order.delivery_partner_id, // Include partner ID
                deliveryPartnerName: order.delivery_partner_name || null, // Include name if joined
                customerName: order.customer_name,
                customerEmail: order.customer_email,
                customerPhone: order.customer_phone,
                deliveryAddress: order.delivery_address,
                status: order.order_status || 'Processing',
                paymentMethod: order.payment_method || 'COD',
                orderDate: order.order_date ? new Date(order.order_date).toISOString() : new Date().toISOString(),
                acceptedAt: order.accepted_at ? new Date(order.accepted_at).toISOString() : null,
                outForDeliveryAt: order.out_for_delivery_at ? new Date(order.out_for_delivery_at).toISOString() : null,
                deliveredAt: order.delivered_at ? new Date(order.delivered_at).toISOString() : null,
                cartItems: cartItems, // Use the items fetched from order_items
                totalPrice: parseFloat(calculatedTotalPrice.toFixed(2)), // Use calculated price
                // rawOrderDetails: parsedOrderDetails // Keep original JSON if needed for debugging
            };
        } catch (error) {
            console.error(`Error formatting order ${order.id}:`, error);
            return null; // Return null for orders that fail formatting
        }
    }));

    return formatted.filter(Boolean); // Filter out any null results from errors
}

// ============================
// AUTH ROUTES
// ============================

// Forgot Password Route
app.post('/api/forgot-password', async (req, res, next) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    const normalizedEmail = email.trim().toLowerCase();
    try {
        const [rows] = await pool.query('SELECT id, name FROM users WHERE email = ?', [normalizedEmail]);
        if (rows.length === 0) {
            // Don't reveal if email exists for security
            return res.json({ message: 'If the email exists, a reset link has been sent.' });
        }

        const user = rows[0];
        const resetToken = jwt.sign({ id: user.id, email: normalizedEmail }, SECRET_KEY, { expiresIn: '15m' });
        const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${resetToken}`;

        if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
            });
            await transporter.sendMail({
                from: process.env.GMAIL_USER,
                to: normalizedEmail,
                subject: 'DelishDish Password Reset',
                html: `<p>Hi ${user.name},</p><p>Click <a href="${resetUrl}">here</a> to reset your password. Link expires in 15 minutes.</p>`
            });
            console.log(`Password reset email sent to ${normalizedEmail}.`);
        } else {
            console.log('Email not configured. Skipping reset email.');
        }

        res.json({ message: 'If the email exists, a reset link has been sent.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        next(error);
    }
});

// Reset Password Route (GET to serve form)
app.get('/reset-password/:token', (req, res) => {
    const { token } = req.params;
    // Simple HTML form for password reset
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Reset Password - DelishDish</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body class="bg-gray-100 flex items-center justify-center min-h-screen">
            <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
                <h2 class="text-2xl font-bold mb-6 text-center">Reset Your Password</h2>
                <form id="resetForm">
                    <input type="hidden" name="token" value="${token}">
                    <div class="mb-4">
                        <label class="block text-gray-700">New Password</label>
                        <input type="password" name="password" required class="w-full p-2 border rounded">
                    </div>
                    <div class="mb-4">
                        <label class="block text-gray-700">Confirm Password</label>
                        <input type="password" name="confirmPassword" required class="w-full p-2 border rounded">
                    </div>
                    <button type="submit" class="w-full bg-orange-500 text-white py-2 rounded hover:bg-orange-600">Reset Password</button>
                </form>
                <div id="message" class="mt-4 text-center"></div>
            </div>
            <script>
                document.getElementById('resetForm').addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const formData = new FormData(e.target);
                    const password = formData.get('password');
                    const confirmPassword = formData.get('confirmPassword');
                    if (password !== confirmPassword) {
                        document.getElementById('message').innerText = 'Passwords do not match.';
                        return;
                    }
                    if (password.length < 6) {
                        document.getElementById('message').innerText = 'Password must be at least 6 characters.';
                        return;
                    }
                    const response = await fetch('/api/reset-password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: '${token}', password })
                    });
                    const result = await response.json();
                    document.getElementById('message').innerText = result.message;
                    if (response.ok) {
                        setTimeout(() => window.location.href = '/', 2000);
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// Reset Password Route (POST to update password)
app.post('/api/reset-password', async (req, res, next) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ message: 'Token and password are required.' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters.' });

    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, decoded.id]);
        res.json({ message: 'Password reset successfully.' });
    } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            return res.status(400).json({ message: 'Reset link has expired.' });
        }
        if (error instanceof jwt.JsonWebTokenError) {
            return res.status(400).json({ message: 'Invalid reset link.' });
        }
        console.error('Reset password error:', error);
        next(error);
    }
});

app.post('/api/signup', async (req, res, next) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'All fields are required.' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters long.' }); // Basic validation

    try {
        const [existingUsers] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) return res.status(409).json({ message: 'Email already exists.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)', [name, email, hashedPassword, 'user']); // Default role 'user'

        res.status(201).json({ message: 'User created successfully.' });
    } catch (error) {
        console.error("Signup Error:", error);
        next(error);
    }
});

app.post('/api/login', async (req, res, next) => {
    const email = req.body.email ? req.body.email.trim().toLowerCase() : ''; // Normalize email
    const password = req.body.password ? req.body.password.trim() : '';
    // console.log(`\n--- Attempting login for: ${email} ---`);
    if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required." });
    }
    try {
        const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
        if (rows.length === 0) {
            // console.log("Login DEBUG: User not found.");
            return res.status(401).json({ message: "Invalid email or password." });
        }
        const user = rows[0];
        // console.log(`Login DEBUG: Found user: ${user.name} (Role: ${user.role})`);
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            // console.log("Login DEBUG: Password mismatch.");
            return res.status(401).json({ message: "Invalid email or password." });
        }
        // console.log("Login DEBUG: Password match successful!");
        const token = jwt.sign(
            { id: user.id, role: user.role }, // Payload includes id and role
            SECRET_KEY,
            { expiresIn: "1h" } // Token expires in 1 hour
        );
        // Optional: Record login history (can be commented out if not needed)
        // await pool.query("INSERT INTO login_history (user_id) VALUES (?)", [user.id]);
        res.json({ token, role: user.role });
    } catch (error) {
        console.error("--- LOGIN ERROR ---", error);
        next(error);
    }
});

// ============================
// MENU ENDPOINTS (Public)
// ============================
app.get('/api/menu_items', async (req, res, next) => {
    try {
        const query = `SELECT
            id, name, price, description, image_url, category
        FROM menu_items`;

        const [rows] = await pool.query(query);
        const menuItems = rows.map(item => ({
            ...item,
            price: parseFloat(item.price),
            ingredients: [],
            nutrition: {}
        }));
        res.json(menuItems);
    } catch (error) {
        console.error("Error fetching menu items:", error);
        next(error);
    }
});

// ============================
// ORDER ENDPOINTS (Customer)
// ============================

// Place a new Order (requires user login)
app.post('/api/orders', authenticateUser, async (req, res, next) => {
    const { customerName, customerEmail, customerPhone, deliveryAddress, cartItems, paymentMethod } = req.body;

    // Validate input
    if (!customerName || !customerEmail || !deliveryAddress || !cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
        return res.status(400).json({ message: 'Missing or invalid order information.' });
    }
     // Validate payment method against ENUM
    const allowedPaymentMethods = ['COD', 'GPay', 'Card (Future Implementation)'];
    if (paymentMethod && !allowedPaymentMethods.includes(paymentMethod)) {
        return res.status(400).json({ message: 'Invalid payment method specified.' });
    }


    const userId = req.user.id;
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Store cart snapshot in order_details (optional but can be useful)
        const orderDetailsJson = JSON.stringify(cartItems.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, price: item.price })));
        const pm = paymentMethod || 'COD'; // Default to COD if not provided

        // Insert into orders table
        const [orderResult] = await connection.query(
            `INSERT INTO orders (user_id, customer_name, customer_email, customer_phone, delivery_address, order_details, order_status, payment_method)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, customerName, customerEmail, customerPhone, deliveryAddress, orderDetailsJson, 'Processing', pm]
        );
        const orderId = orderResult.insertId;

        // Insert into order_items table
        const itemsPromises = cartItems.map(item => {
            if (typeof item.id === 'undefined' || typeof item.quantity === 'undefined' || typeof item.price === 'undefined' || item.quantity <= 0 || item.price < 0) {
                throw new Error(`Invalid cart item data: ${JSON.stringify(item)}`);
            }
            return connection.query(
                'INSERT INTO order_items (order_id, menu_item_id, quantity, price) VALUES (?, ?, ?, ?)',
                [orderId, item.id, item.quantity, item.price] // Use item.price (price at time of order)
            );
        });
        await Promise.all(itemsPromises);

        // Generate cancellation token
        const cancelToken = jwt.sign({ orderId: orderId, action: 'cancel' }, SECRET_KEY, { expiresIn: '5m' });
        const cancelUrl = `${req.protocol}://${req.get('host')}/api/orders/cancel-from-email/${orderId}/${cancelToken}`; // Use dynamic host

        // Send confirmation email
        try {
            if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
                const transporter = nodemailer.createTransport({ /* ... nodemailer config ... */
                     service: 'gmail',
                     auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
                });
                const totalOrderPrice = cartItems.reduce((sum, i) => sum + (i.price * i.quantity), 0).toFixed(2);
                await transporter.sendMail({
                    from: process.env.GMAIL_USER, to: customerEmail, subject: `DelishDish Order Confirmation - #${orderId}`,
                    html: `<h2>Thank you, ${customerName}!</h2><p>Order #${orderId} placed.</p><ul>${cartItems.map(i => `<li>${i.quantity}x ${i.name || 'Item'} - ₹${(i.price * i.quantity).toFixed(2)}</li>`).join('')}</ul><p><strong>Total: ₹${totalOrderPrice}</strong></p><p>Address: ${deliveryAddress}</p><p>Payment: ${pm}</p><p>Status: Processing</p><hr><p>Cancel within 5 mins: <a href="${cancelUrl}">Cancel Order</a></p>`
                });
                console.log(`Confirmation email sent for order ${orderId}.`);
            } else {
                console.log(`Email not configured. Skipping email for order ${orderId}.`);
            }
        } catch (emailError) {
            console.error(`Error sending email for order ${orderId}:`, emailError);
        }

        await connection.commit();
        res.status(201).json({ message: 'Order placed successfully.', orderId });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error processing order:", error);
        // Check for specific DB errors (e.g., foreign key violation on menu_item_id)
        if (error.code === 'ER_NO_REFERENCED_ROW_2') {
             res.status(400).json({ message: 'Invalid menu item ID found in the order.' });
        } else {
             next(error);
        }
    } finally {
        if (connection) connection.release();
    }
});

// Get User's Orders (requires user login or admin)
app.get('/api/orders/user/:userId', authenticateUser, async (req, res, next) => {
    const requestedUserId = parseInt(req.params.userId, 10);
    const loggedInUserId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    // Allow access if admin or if the user is requesting their own orders
    if (!isAdmin && loggedInUserId !== requestedUserId) {
        return res.status(403).json({ message: 'Access denied.' });
    }

    try {
        const [orders] = await pool.query('SELECT * FROM orders WHERE user_id = ? ORDER BY order_date DESC', [requestedUserId]);
        const formatted = await formatOrders(orders);
        res.json(formatted);
    } catch (error) {
        next(error);
    }
});

// Cancel Order (requires user login, checks ownership)
app.delete('/api/orders/:orderId', authenticateUser, async (req, res, next) => {
    const { orderId } = req.params;
    const userId = req.user.id;

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Check ownership and current status
        const [orderRows] = await connection.query(
            "SELECT order_status FROM orders WHERE id = ? AND user_id = ?",
            [orderId, userId]
        );

        if (orderRows.length === 0) {
            await connection.rollback(); // Release lock
            return res.status(404).json({ message: 'Order not found or you do not have permission to cancel it.' });
        }

        const currentStatus = orderRows[0].order_status;
        const cancellableStatuses = ['Processing', 'Awaiting Acceptance', 'Accepted']; // Allow cancellation even if accepted briefly

        if (!cancellableStatuses.includes(currentStatus)) {
            await connection.rollback(); // Release lock
            return res.status(400).json({ message: `Cannot cancel order with status: ${currentStatus}.` });
        }

        // Update status to 'Cancelled'
        const [result] = await connection.query(
            "UPDATE orders SET order_status = 'Cancelled' WHERE id = ? AND user_id = ?",
            [orderId, userId]
        );

        if (result.affectedRows === 0) {
            // Should not happen due to the check above, but as a safeguard
            await connection.rollback();
            return res.status(404).json({ message: 'Failed to cancel order (maybe status changed).' });
        }

        await connection.commit();
        res.json({ message: 'Order cancelled successfully.' });
    } catch (error) {
        if (connection) await connection.rollback();
        next(error);
    } finally {
        if (connection) connection.release();
    }
});

// Cancel Order via Email Link (Public, relies on token)
app.get('/api/orders/cancel-from-email/:orderId/:token', async (req, res, next) => {
    const { orderId, token } = req.params;
    let connection;
    try {
        const decoded = jwt.verify(token, SECRET_KEY);

        if (decoded.orderId != orderId || decoded.action !== 'cancel') {
            throw new jwt.JsonWebTokenError('Invalid token payload.');
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Check current status (using FOR UPDATE to lock the row briefly)
        const [orderRows] = await connection.query("SELECT order_status FROM orders WHERE id = ? FOR UPDATE", [orderId]);

        if (orderRows.length === 0) {
            await connection.rollback();
            return res.status(404).send('<h1>Order Not Found</h1><p>This order does not exist.</p>');
        }

        const currentStatus = orderRows[0].order_status;
        const cancellableStatuses = ['Processing', 'Awaiting Acceptance', 'Accepted'];

        if (!cancellableStatuses.includes(currentStatus)) {
            await connection.rollback();
            return res.status(400).send(`<h1>Cannot Cancel Order</h1><p>Order status (${currentStatus}) prevents cancellation via this link.</p>`);
        }

        // Update status to 'Cancelled'
        await connection.query("UPDATE orders SET order_status = 'Cancelled' WHERE id = ?", [orderId]);
        await connection.commit();

        res.send(`<h1>Order #${orderId} Cancelled</h1><p>Your order has been successfully cancelled.</p>`);

    } catch (error) {
        if (connection) await connection.rollback();

        if (error instanceof jwt.TokenExpiredError) {
            return res.status(400).send('<h1>Link Expired</h1><p>The 5-minute window to cancel this order has passed.</p>');
        }
        if (error instanceof jwt.JsonWebTokenError) {
            return res.status(400).send('<h1>Invalid Link</h1><p>This cancellation link is invalid or has expired.</p>');
        }
        console.error("Error cancelling order from email:", error);
        next(error); // Pass to central error handler for other errors
    } finally {
         if (connection) connection.release();
    }
});


// Customer Order Tracking Route
app.get('/api/orders/track/:orderId', authenticateUser, async (req, res, next) => {
    const { orderId } = req.params;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    try {
        // Fetch order details, join with delivery partner name if assigned
        const [orderRows] = await pool.query(
            `SELECT o.id, o.order_status, o.order_date, o.accepted_at,
                    o.out_for_delivery_at, o.delivered_at, o.user_id,
                    u_del.name as delivery_partner_name
             FROM orders o
             LEFT JOIN users u_del ON o.delivery_partner_id = u_del.id
             WHERE o.id = ?`,
            [orderId]
        );

        if (orderRows.length === 0) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        const order = orderRows[0];

        // Authorization check: User must own the order or be an admin
        if (!isAdmin && order.user_id !== userId) {
            return res.status(403).json({ message: 'Access denied.' });
        }

        // Simplify data for customer view (don't expose partner ID directly)
        const trackingInfo = {
            orderId: order.id,
            status: order.order_status,
            placedAt: order.order_date ? new Date(order.order_date).toISOString() : null,
            acceptedAt: order.accepted_at ? new Date(order.accepted_at).toISOString() : null,
            outForDeliveryAt: order.out_for_delivery_at ? new Date(order.out_for_delivery_at).toISOString() : null,
            deliveredAt: order.delivered_at ? new Date(order.delivered_at).toISOString() : null,
            // Optionally add estimated delivery time logic here based on status/timestamps
        };

        res.json(trackingInfo);
    } catch (error) {
        next(error);
    }
});

// ============================
// ADMIN ROUTES
// ============================

// Get all orders for admin (includes partner name)
app.get(['/api/orders/admin', '/api/admin/orders'], authenticateAdmin, async (req, res, next) => {
    try {
        const [orders] = await pool.query(`
            SELECT o.*, u_del.name as delivery_partner_name
            FROM orders o
            LEFT JOIN users u_del ON o.delivery_partner_id = u_del.id
            ORDER BY o.order_date DESC
        `);
        const formatted = await formatOrders(orders); // formatOrders now includes partner name if available
        res.json(formatted);
    } catch (error) {
        next(error);
    }
});

// Update order status (admin)
app.put('/api/admin/orders/:orderId/status', authenticateAdmin, async (req, res, next) => { // Renamed slightly for clarity
    const { orderId } = req.params;
    const { status } = req.body;
    // Validate status against the ENUM definition in DB
    const allowedStatuses = ['Processing', 'Awaiting Acceptance', 'Accepted', 'Out for Delivery', 'Delivered', 'Cancelled'];
    if (!status || !allowedStatuses.includes(status)) {
         return res.status(400).json({ message: `Invalid status. Must be one of: ${allowedStatuses.join(', ')}` });
    }

    try {
        // Admins can update any order's status, potentially set timestamps too if needed
        // For simplicity, just updating status here. Add timestamp logic if admin should set them.
        const [result] = await pool.query(
            'UPDATE orders SET order_status = ? WHERE id = ?',
            [status, orderId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        res.json({ message: 'Order status updated successfully by admin.' });
    } catch (error) {
        next(error);
    }
});

// Add new menu item (admin)
app.post('/api/admin/menu_items', authenticateAdmin, async (req, res, next) => {
    try {
        const { name, price, description, image_url, category, ingredients, nutrition } = req.body;
        if (!name || price === undefined || !category || !Array.isArray(ingredients) || typeof nutrition !== 'object' || nutrition === null) {
            return res.status(400).json({ message: 'Invalid data format. Check required fields and types (ingredients: array, nutrition: object).' });
        }
         if (parseFloat(price) < 0) {
             return res.status(400).json({ message: 'Price cannot be negative.' });
         }

        const ingredientsJson = JSON.stringify(ingredients);
        const nutritionJson = JSON.stringify(nutrition);
        const query = `INSERT INTO menu_items (name, price, description, image_url, category, ingredients, nutrition) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const params = [name, parseFloat(price), description || '', image_url || null, category, ingredientsJson, nutritionJson];
        const [result] = await pool.query(query, params);
        res.status(201).json({ message: 'Menu item added successfully', newItemId: result.insertId });
    } catch (error) {
        console.error("Error adding menu item:", error);
        next(error);
    }
});

// Update a menu item (admin)
app.put('/api/admin/menu_items/:id', authenticateAdmin, async (req, res, next) => {
    const { id } = req.params;
    try {
        const { name, price, description, image_url, category, ingredients, nutrition } = req.body;
        if (!name || price === undefined || !category || !Array.isArray(ingredients) || typeof nutrition !== 'object' || nutrition === null) {
            return res.status(400).json({ message: 'Invalid data format. Check required fields and types.' });
        }
        if (parseFloat(price) < 0) {
             return res.status(400).json({ message: 'Price cannot be negative.' });
        }

        const ingredientsJson = JSON.stringify(ingredients);
        const nutritionJson = JSON.stringify(nutrition);
        const query = `UPDATE menu_items SET name = ?, price = ?, description = ?, image_url = ?, category = ?, ingredients = ?, nutrition = ? WHERE id = ?`;
        const params = [name, parseFloat(price), description || '', image_url || null, category, ingredientsJson, nutritionJson, id];
        const [result] = await pool.query(query, params);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Menu item not found.' });
        res.json({ message: 'Menu item updated successfully.' });
    } catch (error) {
        console.error(`Error updating menu item ${id}:`, error);
        next(error);
    }
});

// Delete a menu item (admin)
app.delete('/api/admin/menu_items/:id', authenticateAdmin, async (req, res, next) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM menu_items WHERE id = ?', [id]);
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Menu item not found.' });
        res.json({ message: 'Menu item deleted successfully.' });
    } catch (error) {
        console.error(`Error deleting menu item ${id}:`, error);
        if (error.code === 'ER_ROW_IS_REFERENCED_2') {
            return res.status(400).json({ message: 'Cannot delete item: It is used in existing orders.' });
        }
        next(error);
    }
});

// Add a Delivery Partner (admin)
app.post('/api/admin/delivery_partners', authenticateAdmin, async (req, res, next) => {
    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ message: 'Name and email are required.' });

    // Simple password generation (consider more complex rules)
    const generatedPassword = crypto.randomBytes(8).toString('hex');
    console.log(`---> Generated temporary password for ${email}: ${generatedPassword} <---`); // Log for admin ONLY

    try {
        const [existingUsers] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) return res.status(409).json({ message: 'Email already exists.' });

        const hashedPassword = await bcrypt.hash(generatedPassword, 10);
        const [result] = await pool.query('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)', [name, email, hashedPassword, 'delivery']);

        // SECURITY WARNING: Sending password in response is insecure. For demo only.
        res.status(201).json({
            message: 'Delivery partner created. Please share the temporary password securely.',
            partnerId: result.insertId,
            temporaryPassword: generatedPassword // DO NOT DO THIS IN PRODUCTION
        });
    } catch (error) {
        next(error);
    }
});

// List Delivery Partners (admin)
app.get('/api/admin/delivery_partners', authenticateAdmin, async (req, res, next) => {
    try {
        const [partners] = await pool.query("SELECT id, name, email FROM users WHERE role = 'delivery' ORDER BY name");
        res.json(partners);
    } catch (error) {
        next(error);
    }
});

// (Optional) Assign Order to Partner (admin)
app.put('/api/admin/orders/:orderId/assign/:partnerId', authenticateAdmin, async (req, res, next) => {
    const { orderId, partnerId } = req.params;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Check partner validity
        const [partnerRows] = await connection.query("SELECT id FROM users WHERE id = ? AND role = 'delivery'", [partnerId]);
        if (partnerRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Delivery partner not found or invalid.' });
        }

        // Check order status and update atomically
        const [result] = await connection.query(
            `UPDATE orders SET delivery_partner_id = ?, order_status = 'Awaiting Acceptance'
             WHERE id = ? AND order_status = 'Processing'`, // Only assign if currently 'Processing'
            [partnerId, orderId]
        );

        if (result.affectedRows === 0) {
            await connection.rollback();
            const [currentOrder] = await connection.query("SELECT order_status FROM orders WHERE id = ?", [orderId]);
             if (currentOrder.length === 0) return res.status(404).json({ message: 'Order not found.' });
             return res.status(409).json({ message: `Order status is '${currentOrder[0].order_status}', cannot assign.` });
        }

        await connection.commit();
        // Optional: Notify the partner here

        res.json({ message: `Order ${orderId} assigned to partner ${partnerId}. Status: Awaiting Acceptance.` });

    } catch (error) {
        if (connection) await connection.rollback();
        next(error);
    } finally {
        if (connection) connection.release();
    }
});


// ============================
// DELIVERY PARTNER ROUTES 🚚
// ============================

// Get Available Orders (delivery)
app.get('/api/delivery/orders/available', authenticateDelivery, async (req, res, next) => {
    try {
        // Fetch orders ready for pickup, not yet assigned OR assigned but awaiting acceptance
        const [orders] = await pool.query(
            `SELECT * FROM orders
             WHERE (order_status = 'Processing' AND delivery_partner_id IS NULL)
                OR (order_status = 'Awaiting Acceptance' AND delivery_partner_id = ?)
             ORDER BY order_date ASC`,
             [req.user.id] // Include orders specifically assigned to them
        );
        const formatted = await formatOrders(orders);
        res.json(formatted);
    } catch (error) {
        next(error);
    }
});

// Get Partner's Accepted Orders (delivery)
app.get('/api/delivery/orders/my', authenticateDelivery, async (req, res, next) => {
    const partnerId = req.user.id;
    try {
        const [orders] = await pool.query(
            "SELECT * FROM orders WHERE delivery_partner_id = ? AND order_status IN ('Accepted', 'Out for Delivery') ORDER BY order_date ASC",
            [partnerId]
        );
        const formatted = await formatOrders(orders);
        res.json(formatted);
    } catch (error) {
        next(error);
    }
});

// Accept an Order (delivery)
app.put('/api/delivery/orders/:orderId/accept', authenticateDelivery, async (req, res, next) => {
    const { orderId } = req.params;
    const partnerId = req.user.id;
    const currentTime = new Date();
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Atomically check status and assign partner using FOR UPDATE
        const [orderRows] = await connection.query(
            "SELECT order_status, delivery_partner_id FROM orders WHERE id = ? FOR UPDATE",
            [orderId]
        );

        if (orderRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ message: 'Order not found.' });
        }

        const currentStatus = orderRows[0].order_status;
        const currentPartnerId = orderRows[0].delivery_partner_id;

        // Check if acceptable (Processing and unassigned, OR Awaiting Acceptance and assigned to *this* partner)
        const canAccept = (currentStatus === 'Processing' && currentPartnerId === null) ||
                          (currentStatus === 'Awaiting Acceptance' && currentPartnerId === partnerId);

        if (!canAccept) {
            await connection.rollback();
             if (currentPartnerId !== null && currentPartnerId !== partnerId) {
                 return res.status(409).json({ message: 'Order already accepted by another partner.' });
             }
             return res.status(400).json({ message: `Cannot accept order with status: ${currentStatus}.` });
        }

        // Update the order
        const [result] = await connection.query(
            "UPDATE orders SET delivery_partner_id = ?, order_status = 'Accepted', accepted_at = ? WHERE id = ?",
            [partnerId, currentTime, orderId]
        );

         if (result.affectedRows === 0) {
             // Should not happen with FOR UPDATE, but good check
             await connection.rollback();
             return res.status(500).json({ message: 'Failed to accept order, possibly due to concurrent update.' });
         }

        await connection.commit();
        res.json({ message: 'Order accepted successfully.' });

    } catch (error) {
        if (connection) await connection.rollback();
        next(error);
    } finally {
        if (connection) connection.release();
    }
});


// Update Order Status (delivery - for assigned orders)
app.put('/api/delivery/orders/:orderId/status', authenticateDelivery, async (req, res, next) => {
    const { orderId } = req.params;
    const partnerId = req.user.id;
    const { status } = req.body; // Expect 'Out for Delivery' or 'Delivered'

    const allowedStatusesMap = {
        'Accepted': 'Out for Delivery',
        'Out for Delivery': 'Delivered'
    };
    if (!status || !Object.values(allowedStatusesMap).includes(status)) {
        return res.status(400).json({ message: `Invalid target status. Allowed: ${Object.values(allowedStatusesMap).join(', ')}` });
    }

    const currentTime = new Date();
    let timestampField = null;
    let requiredCurrentStatus = null;

    if (status === 'Out for Delivery') {
         timestampField = 'out_for_delivery_at';
         requiredCurrentStatus = 'Accepted';
    }
    if (status === 'Delivered') {
         timestampField = 'delivered_at';
         requiredCurrentStatus = 'Out for Delivery';
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Check ownership and current status atomically
        const [orderRows] = await connection.query(
            "SELECT order_status FROM orders WHERE id = ? AND delivery_partner_id = ? FOR UPDATE",
            [orderId, partnerId]
        );

        if (orderRows.length === 0) {
            await connection.rollback();
            return res.status(403).json({ message: 'Order not found or not assigned to you.' });
        }

        const currentStatus = orderRows[0].order_status;
        if (currentStatus !== requiredCurrentStatus) {
            await connection.rollback();
            return res.status(400).json({ message: `Cannot update to '${status}'. Order status must be '${requiredCurrentStatus}', but it is '${currentStatus}'.` });
        }

        // Update status and timestamp
        let query = `UPDATE orders SET order_status = ?, ${timestampField} = ? WHERE id = ? AND delivery_partner_id = ?`;
        const params = [status, currentTime, orderId, partnerId];

        const [result] = await connection.query(query, params);

        if (result.affectedRows === 0) {
            await connection.rollback();
            return res.status(500).json({ message: 'Failed to update order status, possibly due to concurrent update.' });
        }

        await connection.commit();

        // Optional: Notify customer upon status change

        res.json({ message: `Order status updated to ${status}.` });

    } catch (error) {
        if (connection) await connection.rollback();
        next(error);
    } finally {
        if (connection) connection.release();
    }
});


// ============================
// FITNESS ROUTE
// ============================

app.post('/api/fitness', async (req, res, next) => {
    try {
        const { name, age, height, weight } = req.body;
        if (!name || !age || !height || !weight || isNaN(age) || isNaN(height) || isNaN(weight) || height <= 0 || weight <= 0 || age <= 0)
            return res.status(400).json({ message: 'Valid name, age (>0), height (>0, cm), and weight (>0, kg) are required.' });

        const heightInMeters = height / 100;
        const bmi = weight / (heightInMeters * heightInMeters);

        let status = 'Normal weight';
        if (bmi < 18.5) status = 'Underweight';
        else if (bmi >= 25 && bmi < 30) status = 'Overweight';
        else if (bmi >= 30) status = 'Obese';

        const foodQuery = `SELECT id, name, price FROM menu_items WHERE category = ? LIMIT 5`;

        const [weightLossRows] = await pool.query(foodQuery, ['Weight Loss']);
        const [weightGainRows] = await pool.query(foodQuery, ['Weight Gain']);

        const weightLossFoods = weightLossRows.map(item => ({
            ...item,
            price: parseFloat(item.price),
            ingredients: [],
            nutrition: {}
        }));
        const weightGainFoods = weightGainRows.map(item => ({
            ...item,
            price: parseFloat(item.price),
            ingredients: [],
            nutrition: {}
        }));

        const baseCalories = 2000; // Simplified

        res.json({
            name,
            bmi: parseFloat(bmi.toFixed(2)),
            status,
            weightLoss: { calories: Math.max(1200, baseCalories - 500), foods: weightLossFoods },
            weightGain: { calories: baseCalories + 500, foods: weightGainFoods }
        });
    } catch (error) {
        console.error("Error in fitness calculation:", error);
        next(error);
    }
});

// ============================
// ERROR HANDLER (Keep this last)
// ============================
app.use((err, req, res, next) => {
    console.error("--- UNHANDLED ERROR ---");
    console.error(err && err.stack ? err.stack : err);
    res.status(err.status || 500).json({ // Use err.status if available
         message: err.message || 'Internal Server Error'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});