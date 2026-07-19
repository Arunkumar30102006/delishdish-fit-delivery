-- Use the target database
USE food_order_db;

-- ======================
-- DROP TABLES (Ensure correct order to avoid foreign key issues)
-- ======================
DROP TABLE IF EXISTS login_history;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS customer_details; -- Depends on orders
DROP TABLE IF EXISTS orders;         -- Depends on users, menu_items
DROP TABLE IF EXISTS menu_items;
DROP TABLE IF EXISTS users;

-- ======================
-- 1. CREATE USERS TABLE (Added 'delivery' role, phone, address for 3NF)
-- ======================
CREATE TABLE users (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Changed to UNSIGNED for consistency
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    phone VARCHAR(20), -- Added for customer phone
    address TEXT, -- Added for delivery address
    role ENUM('user', 'admin', 'delivery') NOT NULL DEFAULT 'user', -- Added 'delivery' role
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Index for faster email lookups
CREATE INDEX idx_user_email ON users(email);

-- ======================
-- 2. CREATE MENU_ITEMS TABLE
-- ======================
CREATE TABLE menu_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Changed to UNSIGNED
    name VARCHAR(100) NOT NULL,
    price DECIMAL(10,2) NOT NULL CHECK (price >= 0), -- Ensure price is not negative
    description TEXT, -- Allow NULL description if needed
    image_url VARCHAR(255), -- Allow NULL if image is optional
    category VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ======================
-- 2a. CREATE INGREDIENTS TABLE (For 3NF, to normalize ingredients)
-- ======================
CREATE TABLE ingredients (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    menu_item_id INT UNSIGNED NOT NULL,
    ingredient VARCHAR(100) NOT NULL,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

-- ======================
-- 2b. CREATE NUTRITION TABLE (For 3NF, to normalize nutrition)
-- ======================
CREATE TABLE nutrition (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    menu_item_id INT UNSIGNED NOT NULL,
    calories DECIMAL(10,2),
    protein_g DECIMAL(10,2),
    carbs_g DECIMAL(10,2),
    fat_g DECIMAL(10,2),
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE CASCADE
);

-- Index for category filtering
CREATE INDEX idx_menu_category ON menu_items(category);

-- ======================
-- 3. CREATE ORDERS TABLE (Added delivery partner info and expanded status)
-- ======================
CREATE TABLE orders (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Changed to UNSIGNED
    user_id INT UNSIGNED NOT NULL,              -- Changed to UNSIGNED
    delivery_partner_id INT UNSIGNED NULL DEFAULT NULL, -- NEW: Link to delivery partner
    order_details JSON,                         -- Store cart snapshot or details if needed
    order_status ENUM(
        'Processing',           -- Initial state after placement
        'Awaiting Acceptance',    -- Optional: If admin assigns before partner accepts
        'Accepted',             -- Partner accepted the order
        'Out for Delivery',     -- Partner is on the way
        'Delivered',            -- Order completed
        'Cancelled'             -- Order cancelled
        ) NOT NULL DEFAULT 'Processing', -- Updated statuses
    payment_method ENUM('COD','GPay','Card (Future Implementation)') NOT NULL DEFAULT 'COD', -- Adjusted options
    order_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    -- NEW Timestamps for tracking
    accepted_at DATETIME NULL DEFAULT NULL,
    out_for_delivery_at DATETIME NULL DEFAULT NULL,
    delivered_at DATETIME NULL DEFAULT NULL,

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, -- Customer who placed order
    FOREIGN KEY (delivery_partner_id) REFERENCES users(id) ON DELETE SET NULL -- Set partner to NULL if user deleted
);

-- Indexes for performance
CREATE INDEX idx_order_user_id ON orders(user_id);
CREATE INDEX idx_order_delivery_partner_id ON orders(delivery_partner_id);
CREATE INDEX idx_order_status ON orders(order_status);

-- ======================
-- 3a. CREATE CUSTOMER_DETAILS TABLE (For 3NF, to avoid redundancy in orders)
-- ======================
CREATE TABLE customer_details (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    order_id INT UNSIGNED NOT NULL,
    customer_name VARCHAR(100) NOT NULL,
    customer_email VARCHAR(100) NOT NULL,
    customer_phone VARCHAR(20),
    delivery_address TEXT NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- Indexes for customer_details
CREATE INDEX idx_customer_details_order_id ON customer_details(order_id);

-- ======================
-- 4. CREATE ORDER_ITEMS TABLE
-- ======================
CREATE TABLE order_items (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Changed to UNSIGNED
    order_id INT UNSIGNED NOT NULL,             -- Changed to UNSIGNED
    menu_item_id INT UNSIGNED NOT NULL,         -- Changed to UNSIGNED
    quantity INT UNSIGNED NOT NULL CHECK (quantity > 0), -- Ensure quantity is positive
    price DECIMAL(10,2) NOT NULL CHECK (price >= 0), -- Price at the time of order
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (menu_item_id) REFERENCES menu_items(id) ON DELETE RESTRICT -- Prevent deleting menu item if in an order
);

-- Indexes for faster queries
CREATE INDEX idx_order_items_order_id ON order_items(order_id);
CREATE INDEX idx_order_items_menu_item_id ON order_items(menu_item_id);

-- ======================
-- 5. CREATE LOGIN_HISTORY TABLE
-- ======================
CREATE TABLE login_history (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, -- Changed to UNSIGNED
    user_id INT UNSIGNED NOT NULL,              -- Changed to UNSIGNED
    login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for user ID lookup
CREATE INDEX idx_login_history_user_id ON login_history(user_id);


-- ======================
-- 6. INSERT INITIAL ADMIN USER
-- ======================
-- Ensure this password hash is correct for 'Ak@30102006' using bcrypt's method
INSERT INTO users (name, email, password, role) VALUES (
    'Arun Kumar',
    'arunkumar30102006@gmail.com',
    '$2b$10$WwmZ7pt77IqCBcrWT0Ozt.UGu8SMZqMul5vcTt..2UiNCqIHJ2lyO', -- Verify this hash matches 'Ak@30102006'
    'admin'
);

-- ======================
-- 7. INSERT SPECIFIC MENU ITEMS PROVIDED BY USER
-- ======================
-- Weight Gain Foods
INSERT INTO menu_items (name, price, description, image_url, category) VALUES
('Butter Chicken', 250.00, 'Creamy tomato-based curry with tender chicken pieces, rich in protein.', 'https://masalaandchai.com/wp-content/uploads/2022/03/Butter-Chicken.jpg', 'Weight Gain'),
('Paneer Butter Masala', 180.00, 'Cottage cheese cubes cooked in rich buttery tomato gravy.', 'https://www.cubesnjuliennes.com/wp-content/uploads/2019/11/Paneer-Butter-Masala.jpg', 'Weight Gain'),
('Chicken Biryani', 220.00, 'Fragrant basmati rice layered with marinated chicken and spices.', 'https://www.cubesnjuliennes.com/wp-content/uploads/2020/07/Chicken-Biryani-Recipe.jpg', 'Weight Gain'),
('Rogan Josh', 250.00, 'Tender lamb pieces cooked in a rich aromatic gravy.', 'https://www.spiceandcolour.com/wp-content/uploads/2022/11/DSC_0702_editado-rotated.jpg', 'Weight Gain'),
('Tandoori Chicken', 200.00, 'Spicy marinated chicken grilled in a tandoor.', 'https://www.cubesnjuliennes.com/wp-content/uploads/2022/12/Tandoori-Chicken-Recipe.jpg', 'Weight Gain');

-- Insert ingredients for Weight Gain Foods
INSERT INTO ingredients (menu_item_id, ingredient) VALUES
(1, 'Chicken'), (1, 'Cream'), (1, 'Tomato Puree'), (1, 'Cashew Paste'), (1, 'Butter'), (1, 'Garam Masala'),
(2, 'Paneer'), (2, 'Butter'), (2, 'Tomato'), (2, 'Cream'), (2, 'Ginger'), (2, 'Spices'),
(3, 'Basmati Rice'), (3, 'Chicken'), (3, 'Yogurt'), (3, 'Onion'), (3, 'Ginger Garlic Paste'), (3, 'Saffron'),
(4, 'Lamb'), (4, 'Yogurt'), (4, 'Ginger'), (4, 'Fennel Powder'), (4, 'Kashmiri Chili'),
(5, 'Chicken'), (5, 'Yogurt'), (5, 'Lemon Juice'), (5, 'Tandoori Masala'), (5, 'Ginger Garlic Paste');

-- Insert nutrition for Weight Gain Foods
INSERT INTO nutrition (menu_item_id, calories, protein_g, carbs_g, fat_g) VALUES
(1, 650, 40.5, 35.0, 40.8),
(2, 580, 30.0, 45.0, 35.0),
(3, 750, 45.0, 80.0, 28.0),
(4, 600, 42.0, 30.0, 36.0),
(5, 450, 55.0, 5.0, 22.0);

-- Weight Loss Foods
INSERT INTO menu_items (name, price, description, image_url, category) VALUES
('Vegetable Biryani', 180.00, 'Mixed vegetables and aromatic rice cooked with Indian spices, light on calories.', 'https://j6e2i8c9.delivery.rocketcdn.me/wp-content/uploads/2019/01/Shahi-Veg-Biryani-Recipe-01.jpg', 'Weight Loss'),
('Masala Dosa', 120.00, 'Crispy rice crepe filled with spiced potato, served with chutney and sambar.', 'https://www.cookwithmanali.com/wp-content/uploads/2020/05/Masala-Dosa-500x500.jpg', 'Weight Loss'),
('Chole Bhature', 150.00, 'Spicy chickpea curry with fluffy bread, rich in fiber and protein.', 'https://kashish.shoutersharks.com/wp-content/uploads/2025/06/IMG_0727-4-scaled-1.jpg', 'Weight Loss'),
('Pav Bhaji', 130.00, 'Spiced mixed vegetable mash served with buttered buns, low in fat.', 'https://www.cookwithmanali.com/wp-content/uploads/2018/05/Best-Pav-Bhaji-Recipe.jpg', 'Weight Loss'),
('Salad Bowl', 120.00, 'Mixed fresh vegetables with sprouts and light dressing, ideal for weight loss.', 'https://m.media-amazon.com/images/I/81WIQyxtWFL.jpg', 'Weight Loss');

-- Insert ingredients for Weight Loss Foods
INSERT INTO ingredients (menu_item_id, ingredient) VALUES
(6, 'Basmati Rice'), (6, 'Carrot'), (6, 'Beans'), (6, 'Peas'), (6, 'Light Spices'),
(7, 'Rice Batter'), (7, 'Potato Masala'), (7, 'Lentils'), (7, 'Coconut Chutney'),
(8, 'Chickpeas'), (8, 'Wheat Flour'), (8, 'Spices'), (8, 'Yogurt (in bhatura dough)'),
(9, 'Potato'), (9, 'Cauliflower'), (9, 'Peas'), (9, 'Pav Bhaji Masala'), (9, 'Wheat Bun'),
(10, 'Lettuce'), (10, 'Cucumber'), (10, 'Tomato'), (10, 'Bell Peppers'), (10, 'Sprouts'), (10, 'Olive Oil Dressing');

-- Insert nutrition for Weight Loss Foods
INSERT INTO nutrition (menu_item_id, calories, protein_g, carbs_g, fat_g) VALUES
(6, 420, 12.0, 60.0, 15.0),
(7, 300, 8.0, 55.0, 5.0),
(8, 680, 25.0, 85.0, 28.0),
(9, 480, 10.0, 70.0, 18.0),
(10, 250, 15.0, 30.0, 8.0);

-- Balanced Foods
INSERT INTO menu_items (name, price, description, image_url, category, ingredients, nutrition) VALUES
('Dal Makhani', 160.00, 'Black lentils simmered in creamy tomato and butter gravy, rich in protein and iron.', 'https://www.cookwithmanali.com/wp-content/uploads/2019/04/Restaurant-Style-Dal-Makhani.jpg', 'Balanced',
    JSON_ARRAY("Black Urad Dal", "Kidney Beans", "Cream", "Butter", "Tomato", "Ginger"),
    JSON_OBJECT("calories", 400, "protein_g", 20.0, "carbs_g", 50.0, "fat_g", 15.0)),
('Paneer Tikka', 180.00, 'Grilled cottage cheese cubes marinated in Indian spices, healthy protein snack.', 'https://www.cookwithmanali.com/wp-content/uploads/2015/07/Restaurant-Style-Recipe-Paneer-Tikka-500x500.jpg', 'Balanced',
    JSON_ARRAY("Paneer", "Yogurt", "Besan", "Capsicum", "Onion", "Tikka Masala"),
    JSON_OBJECT("calories", 350, "protein_g", 28.0, "carbs_g", 10.0, "fat_g", 22.0)),
('Mango Lassi', 120.00, 'Refreshing yogurt-based mango smoothie with probiotics and vitamins.', 'https://lentillovingfamily.com/wp-content/uploads/2025/05/mango-lassi-2.jpg', 'Balanced',
    JSON_ARRAY("Mango Pulp", "Yogurt", "Sugar/Honey", "Cardamom"),
    JSON_OBJECT("calories", 280, "protein_g", 8.0, "carbs_g", 50.0, "fat_g", 5.0)),
('Mixed Vegetable Curry', 150.00, 'Seasonal vegetables cooked in light spices, rich in vitamins and minerals.', 'https://savoryspin.com/wp-content/uploads/2023/10/Creamy-Vegetable-Curry-With-Frozen-Vegetables.jpg', 'Balanced',
    JSON_ARRAY("Seasonal Vegetables", "Coconut Milk", "Light Curry Powder", "Turmeric"),
    JSON_OBJECT("calories", 320, "protein_g", 10.0, "carbs_g", 45.0, "fat_g", 12.0)),
('Quinoa Khichdi', 180.00, 'Balanced dish of quinoa and lentils, high in protein and fiber.', 'https://mytastycurry.com/wp-content/uploads/2019/07/Quinoa-Khichdi-1.jpg', 'Balanced',
    JSON_ARRAY("Quinoa", "Moong Dal", "Turmeric", "Ginger", "Ghee"),
    JSON_OBJECT("calories", 450, "protein_g", 25.0, "carbs_g", 55.0, "fat_g", 15.0));

-- Weight Loss Foods (Additional)
INSERT INTO menu_items (name, price, description, image_url, category) VALUES
('Grilled Chicken Breast', 200, 'Lean protein, perfect for weight loss.', 'https://www.cookinwithmima.com/wp-content/uploads/2021/06/Grilled-BBQ-Chicken.jpg', 'Weight Loss'),
('Greek Yogurt with Berries', 150, 'High protein snack with antioxidants.', 'https://gratefulgrazer.com/wp-content/uploads/2025/03/yogurt-bowl-serving.jpg', 'Weight Loss'),
('Quinoa Salad', 180, 'Healthy salad with quinoa and veggies.', 'https://cdn.loveandlemons.com/wp-content/uploads/2020/08/quinoa-salad.jpg', 'Weight Loss');

-- Insert ingredients for Weight Loss Foods (Additional)
INSERT INTO ingredients (menu_item_id, ingredient) VALUES
(16, 'Chicken Breast'), (16, 'Olive Oil'), (16, 'Lemon Juice'), (16, 'Black Pepper'),
(17, 'Greek Yogurt'), (17, 'Mixed Berries'), (17, 'Honey'), (17, 'Almonds'),
(18, 'Quinoa'), (18, 'Cucumber'), (18, 'Tomato'), (18, 'Feta Cheese'), (18, 'Mint'), (18, 'Vinaigrette');

-- Insert nutrition for Weight Loss Foods (Additional)
INSERT INTO nutrition (menu_item_id, calories, protein_g, carbs_g, fat_g) VALUES
(16, 300, 45.0, 2.0, 10.0),
(17, 220, 20.0, 25.0, 5.0),
(18, 350, 15.0, 40.0, 15.0);

-- Weight Gain Foods (Additional)
INSERT INTO menu_items (name, price, description, image_url, category) VALUES
('Peanut Butter Smoothie', 120, 'High-calorie smoothie for weight gain.', 'https://i.pinimg.com/736x/24/bd/73/24bd73d7850da1b103789474dbc50fa3.jpg', 'Weight Gain'),
('Banana & Whey Protein Shake', 130, 'Protein shake with banana.', 'https://www.proteincakery.com/wp-content/uploads/2023/11/banana-protein-shake-pin-13.jpg', 'Weight Gain'),
('Brown Rice with Chicken & Avocado', 250, 'Balanced weight gain meal.', 'https://assets.hotcooking.co.uk/portrait45/pulled-chicken-brown-rice-burrito-bowl_large.jpg', 'Weight Gain');

-- Insert ingredients for Weight Gain Foods (Additional)
INSERT INTO ingredients (menu_item_id, ingredient) VALUES
(19, 'Peanut Butter'), (19, 'Milk'), (19, 'Banana'), (19, 'Oats'), (19, 'Protein Powder'),
(20, 'Banana'), (20, 'Whey Protein Powder'), (20, 'Milk'), (20, 'Ice'),
(21, 'Brown Rice'), (21, 'Chicken'), (21, 'Avocado'), (21, 'Black Beans'), (21, 'Salsa');

-- Insert nutrition for Weight Gain Foods (Additional)
INSERT INTO nutrition (menu_item_id, calories, protein_g, carbs_g, fat_g) VALUES
(19, 550, 20.0, 50.0, 30.0),
(20, 480, 35.0, 40.0, 20.0),
(21, 620, 40.0, 60.0, 25.0);

-- ======================
-- 8. VERIFY INSERTIONS
-- ======================
SELECT COUNT(*) AS user_count FROM users;
SELECT COUNT(*) AS menu_item_count FROM menu_items;
SELECT id, name, category FROM menu_items LIMIT 10;
SELECT * FROM orders; -- Should be empty
SELECT * FROM order_items; -- Should be empty
SELECT * FROM login_history; -- May have entries

-- ======================
-- END OF SCRIPT
-- ======================