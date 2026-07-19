const bcrypt = require('bcrypt');
const password = 'Ak@30102006'; // The password you want to use
const saltRounds = 10;

bcrypt.hash(password, saltRounds, function(err, hash) {
    if (err) {
        console.error("Error hashing password:", err);
        return;
    }
    console.log("\n✅ Your new, correct password hash is:");
    console.log(hash);
    console.log("\n👉 Run this SQL command in your database to fix the admin password:");
    console.log(`UPDATE users SET password = '${hash}' WHERE email = 'arunkumar30102006@gmail.com';`);
});