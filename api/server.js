// api/server.js - Complete API Server with Database Secret

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ========================================
// FIREBASE ADMIN - SIMPLE INITIALIZATION
// ========================================
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "https://shop-good-81afa-default-rtdb.firebaseio.com";
const FIREBASE_DATABASE_SECRET = process.env.FIREBASE_DATABASE_SECRET || "8qexZglGAbuGEf3Y5Q5NINnIvXdnyMwB36jYAzB8";

admin.initializeApp({
    credential: admin.credential.refreshToken({
        clientId: "firebase-adminsdk",
        clientEmail: "firebase-adminsdk@shop-good-81afa.iam.gserviceaccount.com",
        privateKey: FIREBASE_DATABASE_SECRET,
        projectId: "shop-good-81afa"
    }),
    databaseURL: FIREBASE_DATABASE_URL
});

const db = admin.database();

// ========================================
// CONFIGURATION
// ========================================
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "sk_live_ab7922d48f66074fc1b95916be75b812d4679ae8";
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || "pk_live_db3b9ef57c141fc9c457990b8dd6e5411e9bfba8";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "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";

// ========================================
// MIDDLEWARE - AUTH VERIFICATION
// ========================================
const verifyAuth = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const token = authHeader.split('Bearer ')[1];
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
};

// ========================================
// HELPER FUNCTIONS
// ========================================
const generateOrderNumber = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = 'SG';
    for (let i = 0; i < 7; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

const generateVoucherCode = (prefix = 'VC') => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = prefix;
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

const sendNotification = async (uid, title, message, type = 'info', data = {}) => {
    try {
        const notificationRef = db.ref(`notifications/${uid}`).push();
        await notificationRef.set({
            id: notificationRef.key,
            title,
            message,
            type,
            read: false,
            createdAt: Date.now(),
            data
        });
        return true;
    } catch (error) {
        console.error('Notification error:', error);
        return false;
    }
};

// ========================================
// HEALTH CHECK
// ========================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ========================================
// AUTH ROUTES
// ========================================

app.post('/api/auth/register', async (req, res) => {
    try {
        const { uid, email, displayName, phone, photoURL, role = 'customer' } = req.body;

        if (!uid || !email) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const existingUser = await db.ref(`users/${uid}`).once('value');
        if (existingUser.exists()) {
            await db.ref(`users/${uid}`).update({
                email,
                displayName: displayName || '',
                phone: phone || '',
                photoURL: photoURL || '',
                role,
                lastLogin: Date.now()
            });
        } else {
            await db.ref(`users/${uid}`).set({
                uid,
                email,
                displayName: displayName || '',
                phone: phone || '',
                photoURL: photoURL || '',
                role,
                isActive: true,
                createdAt: Date.now(),
                lastLogin: Date.now(),
                preferences: {
                    notifications: {
                        email: true,
                        browser: true,
                        orders: true,
                        promotions: false
                    }
                }
            });
        }

        const walletRef = db.ref(`wallets/${uid}`);
        const walletSnapshot = await walletRef.once('value');
        if (!walletSnapshot.exists()) {
            await walletRef.set({
                balance: 0,
                createdAt: Date.now(),
                updatedAt: Date.now()
            });
        }

        res.json({ success: true, message: 'User registered successfully' });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/auth/check-email', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email required' });
        }

        const usersRef = db.ref('users');
        const snapshot = await usersRef.orderByChild('email').equalTo(email).once('value');
        const exists = snapshot.exists();

        res.json({ success: true, exists });
    } catch (error) {
        console.error('Check email error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email, redirectUrl } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email required' });
        }

        let userRecord;
        try {
            userRecord = await admin.auth().getUserByEmail(email);
        } catch (authError) {
            if (authError.code === 'auth/user-not-found') {
                return res.status(404).json({ success: false, message: 'No account found with this email' });
            }
            throw authError;
        }

        await admin.auth().generatePasswordResetLink(email, {
            url: redirectUrl || 'https://shop-good.com/login.html',
            handleCodeInApp: true
        });

        await db.ref(`password_resets/${userRecord.uid}`).set({
            email,
            createdAt: Date.now(),
            used: false
        });

        res.json({ success: true, message: 'Password reset email sent' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// USER ROUTES
// ========================================

app.get('/api/users/profile', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`users/${uid}`).once('value');
        const userData = snapshot.val();

        if (!userData) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({ success: true, user: { ...userData, uid } });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/users/update', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { displayName, phone, photoURL, preferences } = req.body;

        const updates = {};
        if (displayName !== undefined) updates.displayName = displayName;
        if (phone !== undefined) updates.phone = phone;
        if (photoURL !== undefined) updates.photoURL = photoURL;
        if (preferences) updates.preferences = preferences;
        updates.updatedAt = Date.now();

        await db.ref(`users/${uid}`).update(updates);

        res.json({ success: true, message: 'Profile updated successfully' });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/users/preferences', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { notifications } = req.body;

        if (notifications) {
            await db.ref(`users/${uid}/preferences/notifications`).update(notifications);
        }

        res.json({ success: true, message: 'Preferences updated' });
    } catch (error) {
        console.error('Update preferences error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/users/recently-viewed', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`users/${uid}/recentlyViewed`).once('value');
        const items = snapshot.val() || [];

        res.json({ success: true, items });
    } catch (error) {
        console.error('Get recently viewed error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/users/recently-viewed', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { items } = req.body;

        await db.ref(`users/${uid}/recentlyViewed`).set(items);

        res.json({ success: true, message: 'Updated' });
    } catch (error) {
        console.error('Update recently viewed error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/users/delete', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        await db.ref(`users/${uid}`).remove();
        await db.ref(`wallets/${uid}`).remove();
        await db.ref(`cart/${uid}`).remove();
        await db.ref(`notifications/${uid}`).remove();
        await db.ref(`wishlist/${uid}`).remove();

        await admin.auth().deleteUser(uid);

        res.json({ success: true, message: 'Account deleted successfully' });
    } catch (error) {
        console.error('Delete account error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/users', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const snapshot = await db.ref('users').once('value');
        const users = snapshot.val() || {};
        const userList = Object.values(users);

        res.json({ success: true, users: userList });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// PRODUCT ROUTES
// ========================================

app.get('/api/products', async (req, res) => {
    try {
        const { limit, categoryId, status, bestSeller } = req.query;

        const snapshot = await db.ref('products').once('value');
        const products = snapshot.val() || {};

        let productList = Object.entries(products).map(([id, data]) => ({
            id,
            ...data
        }));

        if (categoryId) {
            productList = productList.filter(p => p.categoryId === categoryId);
        }
        if (status) {
            productList = productList.filter(p => p.status === status);
        }
        if (bestSeller === 'true') {
            productList = productList.filter(p => p.bestSeller === true);
        }

        productList.sort((a, b) => (b.soldCount || 0) - (a.soldCount || 0));

        if (limit) {
            productList = productList.slice(0, parseInt(limit));
        }

        res.json({ success: true, products: productList });
    } catch (error) {
        console.error('Get products error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/products/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) {
            return res.json({ success: true, products: [] });
        }

        const searchTerm = q.toLowerCase();
        const snapshot = await db.ref('products').once('value');
        const products = snapshot.val() || {};

        const results = Object.entries(products)
            .filter(([id, data]) => {
                const name = (data.name || '').toLowerCase();
                const brand = (data.brand || '').toLowerCase();
                const description = (data.description || '').toLowerCase();
                return name.includes(searchTerm) || brand.includes(searchTerm) || description.includes(searchTerm);
            })
            .map(([id, data]) => ({
                id,
                ...data
            }))
            .slice(0, 50);

        res.json({ success: true, products: results });
    } catch (error) {
        console.error('Search products error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/products/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        const snapshot = await db.ref(`products/${productId}`).once('value');
        const product = snapshot.val();

        if (!product) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        res.json({ success: true, product: { id: productId, ...product } });
    } catch (error) {
        console.error('Get product error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/products', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const { name, categoryId, price, stock, status, description, brand, thumbnail, images, variations } = req.body;

        if (!name || !categoryId || !price) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const productRef = db.ref('products').push();
        const productId = productRef.key;

        const productData = {
            name,
            categoryId,
            price: price || { base: 0, display: 0, discountPercent: 0 },
            stock: stock || { available: 0, reserved: 0, status: 'out_of_stock' },
            status: status || 'active',
            description: description || '',
            brand: brand || '',
            thumbnail: thumbnail || '',
            images: images || [],
            variations: variations || {},
            createdAt: Date.now(),
            updatedAt: Date.now(),
            soldCount: 0,
            rating: { average: 0, count: 0 }
        };

        await productRef.set(productData);

        res.json({ success: true, product: { id: productId, ...productData } });
    } catch (error) {
        console.error('Create product error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/products/:productId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { productId } = req.params;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const { name, categoryId, price, stock, status, description, brand, thumbnail, images, variations } = req.body;

        const productRef = db.ref(`products/${productId}`);
        const snapshot = await productRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        const updates = { updatedAt: Date.now() };
        if (name !== undefined) updates.name = name;
        if (categoryId !== undefined) updates.categoryId = categoryId;
        if (price !== undefined) updates.price = price;
        if (stock !== undefined) updates.stock = stock;
        if (status !== undefined) updates.status = status;
        if (description !== undefined) updates.description = description;
        if (brand !== undefined) updates.brand = brand;
        if (thumbnail !== undefined) updates.thumbnail = thumbnail;
        if (images !== undefined) updates.images = images;
        if (variations !== undefined) updates.variations = variations;

        await productRef.update(updates);

        const updatedSnapshot = await productRef.once('value');
        res.json({ success: true, product: { id: productId, ...updatedSnapshot.val() } });
    } catch (error) {
        console.error('Update product error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/products/:productId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { productId } = req.params;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const productRef = db.ref(`products/${productId}`);
        const snapshot = await productRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        await productRef.remove();
        res.json({ success: true, message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/categories/:categoryId/products', async (req, res) => {
    try {
        const { categoryId } = req.params;
        const snapshot = await db.ref('products').once('value');
        const products = snapshot.val() || {};

        const productList = Object.entries(products)
            .filter(([id, data]) => data.categoryId === categoryId)
            .map(([id, data]) => ({
                id,
                ...data
            }));

        res.json({ success: true, products: productList });
    } catch (error) {
        console.error('Get category products error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// CATEGORY ROUTES
// ========================================

app.get('/api/categories', async (req, res) => {
    try {
        const snapshot = await db.ref('categories').once('value');
        const categories = snapshot.val() || {};

        const categoryList = Object.entries(categories).map(([id, data]) => ({
            id,
            ...data
        }));

        res.json({ success: true, categories: categoryList });
    } catch (error) {
        console.error('Get categories error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/categories/:categoryId', async (req, res) => {
    try {
        const { categoryId } = req.params;
        const snapshot = await db.ref(`categories/${categoryId}`).once('value');
        const category = snapshot.val();

        if (!category) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        res.json({ success: true, category: { id: categoryId, ...category } });
    } catch (error) {
        console.error('Get category error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/categories', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const { name, image, icon, status, description } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, message: 'Category name required' });
        }

        const categoryRef = db.ref('categories').push();
        const categoryId = categoryRef.key;

        const categoryData = {
            name,
            image: image || '',
            icon: icon || 'tag',
            status: status || 'active',
            description: description || '',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await categoryRef.set(categoryData);

        res.json({ success: true, category: { id: categoryId, ...categoryData } });
    } catch (error) {
        console.error('Create category error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/categories/:categoryId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { categoryId } = req.params;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const { name, image, icon, status, description } = req.body;

        const categoryRef = db.ref(`categories/${categoryId}`);
        const snapshot = await categoryRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        const updates = { updatedAt: Date.now() };
        if (name !== undefined) updates.name = name;
        if (image !== undefined) updates.image = image;
        if (icon !== undefined) updates.icon = icon;
        if (status !== undefined) updates.status = status;
        if (description !== undefined) updates.description = description;

        await categoryRef.update(updates);

        const updatedSnapshot = await categoryRef.once('value');
        res.json({ success: true, category: { id: categoryId, ...updatedSnapshot.val() } });
    } catch (error) {
        console.error('Update category error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/categories/:categoryId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { categoryId } = req.params;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const categoryRef = db.ref(`categories/${categoryId}`);
        const snapshot = await categoryRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Category not found' });
        }

        await categoryRef.remove();
        res.json({ success: true, message: 'Category deleted successfully' });
    } catch (error) {
        console.error('Delete category error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// CART ROUTES
// ========================================

app.get('/api/cart', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`cart/${uid}/items`).once('value');
        const cart = snapshot.val() || {};

        res.json({ success: true, cart });
    } catch (error) {
        console.error('Get cart error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/cart/update', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { productId, variationId, quantity, price, name, thumbnail, variationName } = req.body;

        if (!productId || !quantity || quantity < 1) {
            return res.status(400).json({ success: false, message: 'Invalid product data' });
        }

        const cartRef = db.ref(`cart/${uid}/items`);
        const snapshot = await cartRef.once('value');
        const cart = snapshot.val() || {};

        let existingKey = null;
        for (const [key, item] of Object.entries(cart)) {
            if (item.productId === productId && item.variationId === variationId) {
                existingKey = key;
                break;
            }
        }

        if (existingKey) {
            await cartRef.child(existingKey).update({
                quantity: Math.min(quantity, 99),
                updatedAt: Date.now()
            });
        } else {
            const newRef = cartRef.push();
            await newRef.set({
                productId,
                variationId: variationId || null,
                quantity,
                price: price || 0,
                name: name || 'Product',
                thumbnail: thumbnail || '',
                variationName: variationName || '',
                addedAt: Date.now(),
                updatedAt: Date.now()
            });
        }

        res.json({ success: true, message: 'Cart updated successfully' });
    } catch (error) {
        console.error('Update cart error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/cart/remove', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { cartKey } = req.body;

        if (!cartKey) {
            return res.status(400).json({ success: false, message: 'Cart key required' });
        }

        await db.ref(`cart/${uid}/items/${cartKey}`).remove();
        res.json({ success: true, message: 'Item removed from cart' });
    } catch (error) {
        console.error('Remove cart error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/cart/clear', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        await db.ref(`cart/${uid}/items`).remove();
        res.json({ success: true, message: 'Cart cleared successfully' });
    } catch (error) {
        console.error('Clear cart error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// WISHLIST ROUTES
// ========================================

app.get('/api/wishlist', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`wishlist/${uid}/items`).once('value');
        const items = snapshot.val() || {};

        res.json({ success: true, items });
    } catch (error) {
        console.error('Get wishlist error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/wishlist/toggle', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { productId } = req.body;

        if (!productId) {
            return res.status(400).json({ success: false, message: 'Product ID required' });
        }

        const wishlistRef = db.ref(`wishlist/${uid}/items/${productId}`);
        const snapshot = await wishlistRef.once('value');

        let added = false;

        if (snapshot.exists()) {
            await wishlistRef.remove();
            added = false;
        } else {
            await wishlistRef.set({
                productId,
                addedAt: Date.now()
            });
            added = true;
        }

        res.json({ success: true, added });
    } catch (error) {
        console.error('Toggle wishlist error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// ORDER ROUTES
// ========================================

app.get('/api/orders/list', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        const isAdmin = adminCheck.exists() || req.user.email === 'jesseegwuatu@gmail.com';

        let snapshot;
        if (isAdmin) {
            snapshot = await db.ref('orders').once('value');
        } else {
            snapshot = await db.ref('orders').orderByChild('customerUid').equalTo(uid).once('value');
        }

        const orders = snapshot.val() || {};
        const orderList = Object.entries(orders).map(([id, data]) => ({
            id,
            ...data
        }));

        orderList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.json({ success: true, orders: orderList });
    } catch (error) {
        console.error('Get orders error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/orders/:orderId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { orderId } = req.params;

        const snapshot = await db.ref(`orders/${orderId}`).once('value');
        const order = snapshot.val();

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        const isAdmin = adminCheck.exists() || req.user.email === 'jesseegwuatu@gmail.com';

        if (order.customerUid !== uid && !isAdmin) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        res.json({ success: true, order: { id: orderId, ...order } });
    } catch (error) {
        console.error('Get order error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/orders/create', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { orderNumber, deliveryAddress, items, subtotal, deliveryFee, discount, total, paymentMethod, estimatedDelivery } = req.body;

        if (!items || items.length === 0 || !deliveryAddress) {
            return res.status(400).json({ success: false, message: 'Missing order details' });
        }

        const userSnapshot = await db.ref(`users/${uid}`).once('value');
        const userData = userSnapshot.val() || {};

        const orderRef = db.ref('orders').push();
        const orderId = orderRef.key;

        const orderData = {
            orderNumber: orderNumber || generateOrderNumber(),
            customerUid: uid,
            customerName: userData.displayName || '',
            customerEmail: userData.email || '',
            deliveryAddress,
            items: items.map(item => ({
                ...item,
                productId: item.productId || item.id,
                name: item.name || 'Product',
                quantity: item.quantity || 1,
                price: item.price || 0,
                total: (item.price || 0) * (item.quantity || 1),
                thumbnail: item.thumbnail || '',
                variationName: item.variationName || ''
            })),
            subtotal: subtotal || 0,
            deliveryFee: deliveryFee || 0,
            discount: discount || 0,
            total: total || 0,
            paymentMethod: paymentMethod || 'paystack',
            paymentStatus: 'pending',
            orderStatus: 'pending',
            estimatedDelivery: estimatedDelivery || {
                start: Date.now() + (2 * 24 * 60 * 60 * 1000),
                end: Date.now() + (5 * 24 * 60 * 60 * 1000)
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            statusHistory: [{
                status: 'pending',
                note: 'Order placed',
                timestamp: Date.now()
            }]
        };

        await orderRef.set(orderData);

        await sendNotification(uid, 'Order Placed',
            `Your order #${orderData.orderNumber} has been placed successfully.`,
            'order', { orderId, orderNumber: orderData.orderNumber }
        );

        res.json({ success: true, order: { id: orderId, ...orderData } });
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/orders/:orderId/status', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { orderId } = req.params;
        const { status, note } = req.body;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const orderRef = db.ref(`orders/${orderId}`);
        const snapshot = await orderRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const order = snapshot.val();

        await orderRef.update({
            orderStatus: status,
            updatedAt: Date.now(),
            [`statusHistory`]: order.statusHistory ? [...order.statusHistory, {
                status,
                note: note || `Status changed to ${status}`,
                timestamp: Date.now()
            }] : [{
                status,
                note: note || `Status changed to ${status}`,
                timestamp: Date.now()
            }]
        });

        await sendNotification(order.customerUid, `Order ${status}`,
            `Your order #${order.orderNumber} has been updated to: ${status}.`,
            'order', { orderId, orderNumber: order.orderNumber }
        );

        res.json({ success: true, message: 'Order status updated' });
    } catch (error) {
        console.error('Update order status error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/orders/:orderId/cancel', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { orderId } = req.params;
        const { note } = req.body;

        const orderRef = db.ref(`orders/${orderId}`);
        const snapshot = await orderRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const order = snapshot.val();

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        const isAdmin = adminCheck.exists() || req.user.email === 'jesseegwuatu@gmail.com';

        if (order.customerUid !== uid && !isAdmin) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        const cancellableStatuses = ['pending', 'paid', 'confirmed'];
        if (!cancellableStatuses.includes(order.orderStatus)) {
            return res.status(400).json({
                success: false,
                message: `Order cannot be cancelled in its current state: ${order.orderStatus}`
            });
        }

        await orderRef.update({
            orderStatus: 'cancelled',
            updatedAt: Date.now(),
            [`statusHistory`]: order.statusHistory ? [...order.statusHistory, {
                status: 'cancelled',
                note: note || 'Order cancelled',
                timestamp: Date.now()
            }] : [{
                status: 'cancelled',
                note: note || 'Order cancelled',
                timestamp: Date.now()
            }]
        });

        // Release stock if order was paid
        if (order.paymentStatus === 'paid') {
            const items = Object.values(order.items || {});
            for (const item of items) {
                if (item.productId) {
                    const productRef = db.ref(`products/${item.productId}`);
                    const productSnapshot = await productRef.once('value');
                    const product = productSnapshot.val();
                    if (product && product.stock) {
                        await productRef.update({
                            'stock/available': (product.stock.available || 0) + (item.quantity || 1),
                            'stock/reserved': Math.max(0, (product.stock.reserved || 0) - (item.quantity || 1))
                        });
                    }
                }
            }
        }

        await sendNotification(order.customerUid, 'Order Cancelled',
            `Your order #${order.orderNumber} has been cancelled.`,
            'order', { orderId, orderNumber: order.orderNumber }
        );

        res.json({ success: true, message: 'Order cancelled successfully' });
    } catch (error) {
        console.error('Cancel order error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/orders/:orderId/confirm', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { orderId } = req.params;
        const { paymentReference, paymentMethod } = req.body;

        const orderRef = db.ref(`orders/${orderId}`);
        const snapshot = await orderRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const order = snapshot.val();

        if (order.customerUid !== uid) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        await orderRef.update({
            paymentStatus: 'paid',
            orderStatus: 'paid',
            paymentReference: paymentReference,
            paymentMethod: paymentMethod || order.paymentMethod,
            updatedAt: Date.now(),
            [`statusHistory`]: order.statusHistory ? [...order.statusHistory, {
                status: 'paid',
                note: 'Payment confirmed',
                timestamp: Date.now()
            }] : [{
                status: 'paid',
                note: 'Payment confirmed',
                timestamp: Date.now()
            }]
        });

        // Update product stock
        const items = Object.values(order.items || {});
        for (const item of items) {
            if (item.productId) {
                const productRef = db.ref(`products/${item.productId}`);
                const productSnapshot = await productRef.once('value');
                const product = productSnapshot.val();
                if (product && product.stock) {
                    await productRef.update({
                        'stock/available': Math.max(0, (product.stock.available || 0) - (item.quantity || 1)),
                        'stock/reserved': (product.stock.reserved || 0) + (item.quantity || 1),
                        'soldCount': (product.soldCount || 0) + (item.quantity || 1)
                    });
                }
            }
        }

        await sendNotification(uid, 'Payment Confirmed',
            `Payment for order #${order.orderNumber} has been confirmed.`,
            'payment', { orderId, orderNumber: order.orderNumber }
        );

        res.json({ success: true, message: 'Order confirmed' });
    } catch (error) {
        console.error('Confirm order error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/orders/export', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { limit } = req.query;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const snapshot = await db.ref('orders').once('value');
        const orders = snapshot.val() || {};

        let orderList = Object.entries(orders).map(([id, data]) => ({
            id,
            ...data
        }));

        orderList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        if (limit) {
            orderList = orderList.slice(0, parseInt(limit));
        }

        res.json({ success: true, orders: orderList });
    } catch (error) {
        console.error('Export orders error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// WALLET ROUTES
// ========================================

app.get('/api/wallet/balance', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`wallets/${uid}`).once('value');
        const wallet = snapshot.val() || { balance: 0 };

        res.json({ success: true, balance: wallet.balance || 0 });
    } catch (error) {
        console.error('Get wallet balance error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/wallet/transactions', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`wallets/${uid}/transactions`).once('value');
        const transactions = snapshot.val() || {};

        const transactionList = Object.entries(transactions).map(([id, data]) => ({
            id,
            ...data
        }));

        transactionList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.json({ success: true, transactions: transactionList });
    } catch (error) {
        console.error('Get wallet transactions error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/payments/initialize', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { amount, email, type, metadata } = req.body;

        if (!amount || amount < 100) {
            return res.status(400).json({ success: false, message: 'Invalid amount (min ₦100)' });
        }

        const userSnapshot = await db.ref(`users/${uid}`).once('value');
        const userData = userSnapshot.val() || {};

        const reference = `SG_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const response = await axios.post('https://api.paystack.co/transaction/initialize', {
            email: email || userData.email,
            amount: Math.round(amount * 100),
            currency: 'NGN',
            reference,
            callback_url: `${req.headers.origin}/wallet.html`,
            metadata: {
                ...metadata,
                type: type || 'wallet_funding',
                customerUid: uid,
                custom_fields: [{
                    display_name: 'Customer UID',
                    variable_name: 'customer_uid',
                    value: uid
                }]
            }
        }, {
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.data.status) {
            await db.ref(`pending_payments/${reference}`).set({
                uid,
                amount,
                type: type || 'wallet_funding',
                status: 'pending',
                createdAt: Date.now()
            });

            res.json({
                success: true,
                authorization_url: response.data.data.authorization_url,
                reference: reference
            });
        } else {
            throw new Error(response.data.message || 'Payment initialization failed');
        }
    } catch (error) {
        console.error('Payment initialization error:', error);
        res.status(500).json({ success: false, message: error.response?.data?.message || error.message });
    }
});

app.get('/api/payments/verify/:reference', verifyAuth, async (req, res) => {
    try {
        const { reference } = req.params;

        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: {
                Authorization: `Bearer ${PAYSTACK_SECRET}`
            }
        });

        if (response.data.status) {
            const data = response.data.data;

            const pendingRef = await db.ref(`pending_payments/${reference}`).once('value');
            const pending = pendingRef.val();

            if (pending && data.status === 'success') {
                const walletRef = db.ref(`wallets/${pending.uid}`);
                const walletSnapshot = await walletRef.once('value');
                const wallet = walletSnapshot.val() || { balance: 0 };

                const newBalance = (wallet.balance || 0) + (data.amount / 100);

                await walletRef.update({
                    balance: newBalance,
                    updatedAt: Date.now()
                });

                const txRef = db.ref(`wallets/${pending.uid}/transactions`).push();
                await txRef.set({
                    amount: data.amount / 100,
                    type: 'fund',
                    status: 'completed',
                    reference: reference,
                    description: 'Wallet funding via Paystack',
                    createdAt: Date.now()
                });

                await sendNotification(pending.uid, 'Wallet Funded',
                    `₦${(data.amount / 100).toLocaleString()} has been added to your wallet.`,
                    'wallet', { amount: data.amount / 100, reference }
                );

                await pendingRef.remove();

                res.json({
                    success: true,
                    status: 'completed',
                    amount: data.amount / 100
                });
            } else if (data.status === 'success') {
                res.json({
                    success: true,
                    status: 'completed',
                    amount: data.amount / 100,
                    reference: data.reference
                });
            } else {
                res.json({
                    success: true,
                    status: data.status,
                    message: data.gateway_response || 'Payment verification failed'
                });
            }
        } else {
            throw new Error(response.data.message || 'Verification failed');
        }
    } catch (error) {
        console.error('Payment verification error:', error);
        res.status(500).json({ success: false, message: error.response?.data?.message || error.message });
    }
});

app.post('/api/orders/:orderId/pay-with-wallet', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { orderId } = req.params;

        const orderSnapshot = await db.ref(`orders/${orderId}`).once('value');
        const order = orderSnapshot.val();

        if (!order) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        if (order.customerUid !== uid) {
            return res.status(403).json({ success: false, message: 'Access denied' });
        }

        if (order.paymentStatus === 'paid') {
            return res.status(400).json({ success: false, message: 'Order already paid' });
        }

        const walletRef = db.ref(`wallets/${uid}`);
        const walletSnapshot = await walletRef.once('value');
        const wallet = walletSnapshot.val() || { balance: 0 };

        if (wallet.balance < order.total) {
            return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
        }

        const newBalance = (wallet.balance || 0) - order.total;
        await walletRef.update({
            balance: newBalance,
            updatedAt: Date.now()
        });

        const txRef = db.ref(`wallets/${uid}/transactions`).push();
        await txRef.set({
            amount: order.total,
            type: 'payment',
            status: 'completed',
            reference: `ORDER_${order.orderNumber}`,
            description: `Payment for order #${order.orderNumber}`,
            createdAt: Date.now()
        });

        await db.ref(`orders/${orderId}`).update({
            paymentStatus: 'paid',
            orderStatus: 'paid',
            paymentMethod: 'wallet',
            updatedAt: Date.now(),
            [`statusHistory`]: order.statusHistory ? [...order.statusHistory, {
                status: 'paid',
                note: 'Payment via wallet',
                timestamp: Date.now()
            }] : [{
                status: 'paid',
                note: 'Payment via wallet',
                timestamp: Date.now()
            }]
        });

        const items = Object.values(order.items || {});
        for (const item of items) {
            if (item.productId) {
                const productRef = db.ref(`products/${item.productId}`);
                const productSnapshot = await productRef.once('value');
                const product = productSnapshot.val();
                if (product && product.stock) {
                    await productRef.update({
                        'stock/available': Math.max(0, (product.stock.available || 0) - (item.quantity || 1)),
                        'stock/reserved': (product.stock.reserved || 0) + (item.quantity || 1),
                        'soldCount': (product.soldCount || 0) + (item.quantity || 1)
                    });
                }
            }
        }

        await sendNotification(uid, 'Payment Successful',
            `Payment of ₦${order.total.toLocaleString()} for order #${order.orderNumber} was successful via wallet.`,
            'payment', { orderId, orderNumber: order.orderNumber }
        );

        res.json({ success: true, message: 'Payment successful' });
    } catch (error) {
        console.error('Wallet payment error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// NOTIFICATION ROUTES
// ========================================

app.get('/api/notifications', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`notifications/${uid}`).once('value');
        const notifications = snapshot.val() || {};

        const notificationList = Object.entries(notifications).map(([id, data]) => ({
            id,
            ...data
        }));

        notificationList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.json({ success: true, notifications: notificationList });
    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/notifications/unread-count', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`notifications/${uid}`).once('value');
        const notifications = snapshot.val() || {};

        const unread = Object.values(notifications).filter(n => !n.read).length;

        res.json({ success: true, count: unread });
    } catch (error) {
        console.error('Get unread count error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/notifications/:notificationId/read', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { notificationId } = req.params;

        await db.ref(`notifications/${uid}/${notificationId}/read`).set(true);
        res.json({ success: true, message: 'Marked as read' });
    } catch (error) {
        console.error('Mark as read error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/notifications/read-all', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`notifications/${uid}`).once('value');
        const notifications = snapshot.val() || {};

        const updates = {};
        for (const key of Object.keys(notifications)) {
            updates[`${key}/read`] = true;
        }

        if (Object.keys(updates).length > 0) {
            await db.ref(`notifications/${uid}`).update(updates);
        }

        res.json({ success: true, message: 'All marked as read' });
    } catch (error) {
        console.error('Mark all read error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/notifications/:notificationId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { notificationId } = req.params;

        await db.ref(`notifications/${uid}/${notificationId}`).remove();
        res.json({ success: true, message: 'Notification deleted' });
    } catch (error) {
        console.error('Delete notification error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/notifications', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        await db.ref(`notifications/${uid}`).remove();
        res.json({ success: true, message: 'All notifications cleared' });
    } catch (error) {
        console.error('Clear notifications error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// SUPPORT / CHAT ROUTES
// ========================================

app.post('/api/support/chat', verifyAuth, async (req, res) => {
    try {
        const { message, userName, userEmail, history } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, error: 'Message is required' });
        }

        let responseText = null;
        let source = 'openrouter';

        try {
            if (OPENROUTER_API_KEY) {
                const aiResponse = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                    model: 'google/gemini-2.0-flash-exp:free',
                    messages: [
                        {
                            role: 'system',
                            content: `You are Vortex AI, a helpful and friendly shopping assistant for Shop Good, an e-commerce platform in Nigeria. 
                            You help customers with orders, payments, delivery, product inquiries, returns, and general shopping questions.
                            Be concise, friendly, and professional. Keep responses under 3 paragraphs unless detailed information is needed.
                            Your name is Vortex AI. You work for Shop Good (shopgood.com).`
                        },
                        ...(history || []),
                        {
                            role: 'user',
                            content: message
                        }
                    ],
                    temperature: 0.7,
                    max_tokens: 400
                }, {
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://shopgood.com',
                        'X-Title': 'Shop Good Support'
                    },
                    timeout: 8000
                });

                if (aiResponse.data && aiResponse.data.choices && aiResponse.data.choices.length > 0) {
                    responseText = aiResponse.data.choices[0].message.content;
                }
            }
        } catch (aiError) {
            console.error('OpenRouter API error:', aiError.message);
        }

        if (!responseText) {
            source = 'fallback';

            const msg = message.toLowerCase();
            if (msg.includes('order') && (msg.includes('track') || msg.includes('where'))) {
                responseText = "You can track your order in the 'Orders' section of your account. Simply go to your profile and click on 'Orders' to see the status and tracking details of all your orders.";
            } else if (msg.includes('payment') || msg.includes('pay')) {
                responseText = "We accept Paystack (card, bank transfer, USSD), Shop Good Wallet, and Pay on Delivery (for orders above ₦6,000). Payments via Paystack are secure and encrypted.";
            } else if (msg.includes('delivery') || msg.includes('shipping')) {
                responseText = "Delivery typically takes 2-5 business days depending on your location. You'll receive a tracking number once your order is shipped.";
            } else if (msg.includes('return') || msg.includes('refund')) {
                responseText = "We offer a 7-day return policy for eligible items. Items must be in their original condition with all packaging intact. Contact our support team to initiate a return.";
            } else if (msg.includes('wallet') || msg.includes('balance')) {
                responseText = "You can view your wallet balance in the 'Wallet' section of your account. To fund your wallet, click 'Fund Wallet' and follow the payment instructions.";
            } else if (msg.includes('voucher') || msg.includes('gift')) {
                responseText = "You can redeem vouchers and gift cards in the 'Vouchers' section. Enter the code and it will be applied to your account balance or discount your order.";
            } else if (msg.includes('product') || msg.includes('item')) {
                responseText = "You can browse all products in the 'Shop' section. Use the search bar or filters to find exactly what you're looking for.";
            } else if (msg.includes('account') || msg.includes('profile')) {
                responseText = "You can manage your account settings, update your profile, view orders, and manage your wallet from your profile page.";
            } else if (msg.includes('hello') || msg.includes('hi') || msg.includes('hey')) {
                responseText = `Hello ${userName || 'there'}! 👋 Welcome to Shop Good support. How can I assist you today?`;
            } else {
                responseText = "I'm here to help! Could you please provide more details about your question?";
            }
            responseText += "\n\nNeed more help? Contact us at support@shopgood.com.";
        }

        try {
            const logRef = db.ref('chat_logs').push();
            await logRef.set({
                userId: req.user.uid,
                userEmail: userEmail || req.user.email,
                userName: userName || 'Customer',
                message: message,
                response: responseText,
                source: source,
                timestamp: Date.now()
            });
        } catch (logError) {
            console.error('Chat log error:', logError);
        }

        res.json({ success: true, response: responseText, source: source });
    } catch (error) {
        console.error('Chat error:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to process your request' });
    }
});

app.post('/api/support/ticket', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { customerName, customerEmail, category, subject, message, priority } = req.body;

        if (!subject || !message) {
            return res.status(400).json({ success: false, message: 'Subject and message required' });
        }

        const ticketRef = db.ref('support_tickets').push();
        const ticketId = ticketRef.key;

        const ticketData = {
            id: ticketId,
            customerUid: uid,
            customerName: customerName || 'Customer',
            customerEmail: customerEmail || '',
            category: category || 'other',
            subject: subject,
            message: message,
            priority: priority || 'normal',
            status: 'open',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await ticketRef.set(ticketData);

        const adminsSnapshot = await db.ref('admins').once('value');
        const admins = adminsSnapshot.val() || {};
        for (const adminUid of Object.keys(admins)) {
            await sendNotification(adminUid, 'New Support Ticket',
                `New ticket from ${customerName}: ${subject}`,
                'support', { ticketId, subject }
            );
        }

        await sendNotification(uid, 'Ticket Created',
            `Your support ticket has been created. We'll get back to you within 24 hours.`,
            'support', { ticketId, subject }
        );

        res.json({ success: true, ticket: { id: ticketId, ...ticketData } });
    } catch (error) {
        console.error('Create ticket error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/support/tickets', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref('support_tickets').orderByChild('customerUid').equalTo(uid).once('value');
        const tickets = snapshot.val() || {};

        const ticketList = Object.entries(tickets).map(([id, data]) => ({
            id,
            ...data
        }));

        ticketList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.json({ success: true, tickets: ticketList });
    } catch (error) {
        console.error('Get tickets error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// ADDRESS ROUTES
// ========================================

app.get('/api/addresses', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`addresses/${uid}`).once('value');
        const addresses = snapshot.val() || {};

        const addressList = Object.entries(addresses).map(([id, data]) => ({
            id,
            ...data
        }));

        res.json({ success: true, addresses: addressList });
    } catch (error) {
        console.error('Get addresses error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/addresses', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { fullName, phone, state, city, area, address, landmark, instructions, label, isDefault } = req.body;

        if (!fullName || !phone || !state || !city || !area || !address) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const addressRef = db.ref(`addresses/${uid}`).push();
        const addressId = addressRef.key;

        if (isDefault) {
            const snapshot = await db.ref(`addresses/${uid}`).once('value');
            const addresses = snapshot.val() || {};
            for (const [id, data] of Object.entries(addresses)) {
                if (data.isDefault) {
                    await db.ref(`addresses/${uid}/${id}/isDefault`).set(false);
                }
            }
        }

        const addressData = {
            fullName,
            phone,
            state,
            city,
            area,
            address,
            landmark: landmark || '',
            instructions: instructions || '',
            label: label || 'Home',
            isDefault: isDefault || false,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await addressRef.set(addressData);

        res.json({ success: true, address: { id: addressId, ...addressData } });
    } catch (error) {
        console.error('Add address error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/addresses/:addressId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { addressId } = req.params;
        const { fullName, phone, state, city, area, address, landmark, instructions, label, isDefault } = req.body;

        const addressRef = db.ref(`addresses/${uid}/${addressId}`);
        const snapshot = await addressRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Address not found' });
        }

        if (isDefault) {
            const allSnapshot = await db.ref(`addresses/${uid}`).once('value');
            const addresses = allSnapshot.val() || {};
            for (const [id, data] of Object.entries(addresses)) {
                if (data.isDefault && id !== addressId) {
                    await db.ref(`addresses/${uid}/${id}/isDefault`).set(false);
                }
            }
        }

        const updates = {
            fullName,
            phone,
            state,
            city,
            area,
            address,
            landmark: landmark || '',
            instructions: instructions || '',
            label: label || 'Home',
            isDefault: isDefault || false,
            updatedAt: Date.now()
        };

        await addressRef.update(updates);

        const updatedSnapshot = await addressRef.once('value');
        res.json({ success: true, address: { id: addressId, ...updatedSnapshot.val() } });
    } catch (error) {
        console.error('Update address error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/addresses/:addressId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { addressId } = req.params;

        await db.ref(`addresses/${uid}/${addressId}`).remove();
        res.json({ success: true, message: 'Address deleted' });
    } catch (error) {
        console.error('Delete address error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/addresses/:addressId/default', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { addressId } = req.params;

        const snapshot = await db.ref(`addresses/${uid}`).once('value');
        const addresses = snapshot.val() || {};
        for (const [id, data] of Object.entries(addresses)) {
            if (data.isDefault) {
                await db.ref(`addresses/${uid}/${id}/isDefault`).set(false);
            }
        }

        await db.ref(`addresses/${uid}/${addressId}/isDefault`).set(true);

        res.json({ success: true, message: 'Default address updated' });
    } catch (error) {
        console.error('Set default address error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// VOUCHER ROUTES
// ========================================

app.get('/api/vouchers', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.ref(`vouchers/${uid}`).once('value');
        const vouchers = snapshot.val() || {};

        const voucherList = Object.entries(vouchers).map(([id, data]) => ({
            id,
            ...data
        }));

        voucherList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.json({ success: true, vouchers: voucherList });
    } catch (error) {
        console.error('Get vouchers error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/vouchers/redeem', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({ success: false, message: 'Voucher code required' });
        }

        const normalizedCode = code.toUpperCase().trim();

        const globalSnapshot = await db.ref('vouchers_global').orderByChild('code').equalTo(normalizedCode).once('value');
        const globalVouchers = globalSnapshot.val() || {};

        let globalVoucherId = null;
        let globalVoucher = null;

        for (const [id, data] of Object.entries(globalVouchers)) {
            if (data.code === normalizedCode) {
                globalVoucherId = id;
                globalVoucher = data;
                break;
            }
        }

        if (!globalVoucher) {
            const userSnapshot = await db.ref(`vouchers/${uid}`).orderByChild('code').equalTo(normalizedCode).once('value');
            if (userSnapshot.exists()) {
                return res.status(400).json({ success: false, message: 'Voucher already redeemed' });
            }
            return res.status(404).json({ success: false, message: 'Invalid voucher code' });
        }

        if (globalVoucher.status === 'used') {
            return res.status(400).json({ success: false, message: 'Voucher has already been used' });
        }

        if (globalVoucher.expiryDate && globalVoucher.expiryDate <= Date.now()) {
            return res.status(400).json({ success: false, message: 'Voucher has expired' });
        }

        if (globalVoucher.customerEmail && globalVoucher.customerEmail !== req.user.email) {
            return res.status(403).json({ success: false, message: 'This voucher is not assigned to you' });
        }

        const userVoucherRef = db.ref(`vouchers/${uid}`).push();
        const userVoucherId = userVoucherRef.key;

        const voucherData = {
            code: globalVoucher.code,
            type: globalVoucher.type || 'voucher',
            discountType: globalVoucher.discountType || 'fixed',
            value: globalVoucher.value,
            description: globalVoucher.description || '',
            minimumOrder: globalVoucher.minimumOrder || 0,
            expiryDate: globalVoucher.expiryDate || null,
            status: 'active',
            redeemedAt: Date.now(),
            createdAt: Date.now()
        };

        await userVoucherRef.set(voucherData);

        await db.ref(`vouchers_global/${globalVoucherId}/status`).set('used');
        await db.ref(`vouchers_global/${globalVoucherId}/usedBy`).set(uid);
        await db.ref(`vouchers_global/${globalVoucherId}/usedAt`).set(Date.now());

        await sendNotification(uid, 'Voucher Redeemed',
            `Voucher ${globalVoucher.code} has been added to your account.`,
            'wallet', { code: globalVoucher.code, value: globalVoucher.value }
        );

        res.json({ success: true, message: 'Voucher redeemed successfully', voucher: voucherData });
    } catch (error) {
        console.error('Redeem voucher error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/vouchers', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const { code, type, discountType, value, customerEmail, expiryDate, status, description, minimumOrder } = req.body;

        if (!value || value <= 0) {
            return res.status(400).json({ success: false, message: 'Invalid value' });
        }

        const voucherCode = code || generateVoucherCode(type === 'gift_card' ? 'GC' : 'VC');

        const existingSnapshot = await db.ref('vouchers_global').orderByChild('code').equalTo(voucherCode).once('value');
        if (existingSnapshot.exists()) {
            return res.status(400).json({ success: false, message: 'Voucher code already exists' });
        }

        const voucherRef = db.ref('vouchers_global').push();
        const voucherId = voucherRef.key;

        const voucherData = {
            code: voucherCode,
            type: type || 'voucher',
            discountType: discountType || 'fixed',
            value: value,
            customerEmail: customerEmail || '',
            expiryDate: expiryDate || null,
            status: status || 'active',
            description: description || '',
            minimumOrder: minimumOrder || 0,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await voucherRef.set(voucherData);

        if (customerEmail) {
            const usersSnapshot = await db.ref('users').orderByChild('email').equalTo(customerEmail).once('value');
            const users = usersSnapshot.val() || {};
            for (const [userUid, userData] of Object.entries(users)) {
                const userVoucherRef = db.ref(`vouchers/${userUid}`).push();
                await userVoucherRef.set({
                    code: voucherCode,
                    type: voucherData.type,
                    discountType: voucherData.discountType,
                    value: voucherData.value,
                    description: voucherData.description,
                    minimumOrder: voucherData.minimumOrder,
                    expiryDate: voucherData.expiryDate,
                    status: 'active',
                    redeemedAt: Date.now(),
                    createdAt: Date.now()
                });

                await sendNotification(userUid, 'New Voucher',
                    `You've received a voucher ${voucherCode}`,
                    'wallet', { code: voucherCode, value: value }
                );
            }
        }

        res.json({ success: true, voucher: { id: voucherId, ...voucherData } });
    } catch (error) {
        console.error('Create voucher error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/vouchers/:voucherId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { voucherId } = req.params;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        await db.ref(`vouchers_global/${voucherId}`).remove();
        res.json({ success: true, message: 'Voucher deleted' });
    } catch (error) {
        console.error('Delete voucher error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/vouchers/gift-card', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { recipientEmail, amount, message, senderName } = req.body;

        if (!recipientEmail || !amount || amount < 100) {
            return res.status(400).json({ success: false, message: 'Invalid gift card details' });
        }

        const userSnapshot = await db.ref('users').orderByChild('email').equalTo(recipientEmail).once('value');
        const recipientUsers = userSnapshot.val() || {};
        const recipientUids = Object.keys(recipientUsers);

        const code = generateVoucherCode('GC');

        const voucherRef = db.ref('vouchers_global').push();
        const voucherId = voucherRef.key;

        const voucherData = {
            code: code,
            type: 'gift_card',
            discountType: 'fixed',
            value: amount,
            customerEmail: recipientEmail,
            expiryDate: Date.now() + (365 * 24 * 60 * 60 * 1000),
            status: 'active',
            description: `Gift card from ${senderName || 'Shop Good'}`,
            minimumOrder: 0,
            giftCard: {
                senderName: senderName || 'Shop Good',
                senderEmail: req.user.email,
                message: message || '',
                recipientEmail: recipientEmail,
                sentAt: Date.now()
            },
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await voucherRef.set(voucherData);

        for (const recipientUid of recipientUids) {
            const userVoucherRef = db.ref(`vouchers/${recipientUid}`).push();
            await userVoucherRef.set({
                code: code,
                type: 'gift_card',
                discountType: 'fixed',
                value: amount,
                description: voucherData.description,
                minimumOrder: 0,
                expiryDate: voucherData.expiryDate,
                status: 'active',
                redeemedAt: Date.now(),
                createdAt: Date.now(),
                giftCard: voucherData.giftCard
            });

            await sendNotification(recipientUid, 'Gift Card Received',
                `You've received a gift card worth ₦${amount.toLocaleString()} from ${senderName || 'Shop Good'}!`,
                'wallet', { code, amount }
            );
        }

        const txRef = db.ref(`wallets/${uid}/transactions`).push();
        await txRef.set({
            amount: amount,
            type: 'gift_card_purchase',
            status: 'completed',
            reference: `GIFT_${code}`,
            description: `Gift card purchase for ${recipientEmail}`,
            createdAt: Date.now()
        });

        res.json({
            success: true,
            message: 'Gift card sent successfully',
            giftCard: { code, amount, recipientEmail, senderName: senderName || 'Shop Good' }
        });
    } catch (error) {
        console.error('Send gift card error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// PROMOTIONS / FLASH SALE ROUTES
// ========================================

app.get('/api/promotions/flash', async (req, res) => {
    try {
        const snapshot = await db.ref('promotions').once('value');
        const promotions = snapshot.val() || {};

        const promoList = Object.entries(promotions)
            .filter(([id, data]) => data.type === 'flash_sale')
            .map(([id, data]) => ({
                id,
                ...data
            }));

        promoList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.json({ success: true, promotions: promoList });
    } catch (error) {
        console.error('Get flash sales error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/promotions', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const { type, name, discountPercent, endDate, products, status } = req.body;

        if (!name || !discountPercent || !endDate || !products || products.length === 0) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const promoRef = db.ref('promotions').push();
        const promoId = promoRef.key;

        const promoData = {
            type: type || 'flash_sale',
            name,
            discountPercent,
            endDate,
            products,
            status: status || 'active',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await promoRef.set(promoData);

        for (const productId of products) {
            const productRef = db.ref(`products/${productId}`);
            const productSnapshot = await productRef.once('value');
            const product = productSnapshot.val();
            if (product && product.price) {
                const basePrice = product.price.base || 0;
                const discountAmount = basePrice * (discountPercent / 100);
                const displayPrice = basePrice - discountAmount;

                await productRef.update({
                    'price/discountPercent': discountPercent,
                    'price/display': Math.round(displayPrice)
                });
            }
        }

        res.json({ success: true, promotion: { id: promoId, ...promoData } });
    } catch (error) {
        console.error('Create promotion error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/promotions/:promotionId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { promotionId } = req.params;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const { name, discountPercent, endDate, products, status } = req.body;

        const promoRef = db.ref(`promotions/${promotionId}`);
        const snapshot = await promoRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Promotion not found' });
        }

        const oldPromo = snapshot.val();

        if (oldPromo.products && oldPromo.products.length > 0 && oldPromo.discountPercent) {
            for (const productId of oldPromo.products) {
                const productRef = db.ref(`products/${productId}`);
                const productSnapshot = await productRef.once('value');
                const product = productSnapshot.val();
                if (product && product.price) {
                    await productRef.update({
                        'price/discountPercent': 0,
                        'price/display': product.price.base || product.price.display || 0
                    });
                }
            }
        }

        const updates = {
            name,
            discountPercent,
            endDate,
            products,
            status,
            updatedAt: Date.now()
        };

        await promoRef.update(updates);

        for (const productId of products) {
            const productRef = db.ref(`products/${productId}`);
            const productSnapshot = await productRef.once('value');
            const product = productSnapshot.val();
            if (product && product.price) {
                const basePrice = product.price.base || 0;
                const discountAmount = basePrice * (discountPercent / 100);
                const displayPrice = basePrice - discountAmount;

                await productRef.update({
                    'price/discountPercent': discountPercent,
                    'price/display': Math.round(displayPrice)
                });
            }
        }

        const updatedSnapshot = await promoRef.once('value');
        res.json({ success: true, promotion: { id: promotionId, ...updatedSnapshot.val() } });
    } catch (error) {
        console.error('Update promotion error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/promotions/:promotionId', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { promotionId } = req.params;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const promoRef = db.ref(`promotions/${promotionId}`);
        const snapshot = await promoRef.once('value');

        if (!snapshot.exists()) {
            return res.status(404).json({ success: false, message: 'Promotion not found' });
        }

        const promo = snapshot.val();

        if (promo.products && promo.products.length > 0 && promo.discountPercent) {
            for (const productId of promo.products) {
                const productRef = db.ref(`products/${productId}`);
                const productSnapshot = await productRef.once('value');
                const product = productSnapshot.val();
                if (product && product.price) {
                    await productRef.update({
                        'price/discountPercent': 0,
                        'price/display': product.price.base || product.price.display || 0
                    });
                }
            }
        }

        await promoRef.remove();
        res.json({ success: true, message: 'Promotion deleted' });
    } catch (error) {
        console.error('Delete promotion error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// ADMIN MANAGEMENT ROUTES
// ========================================

app.get('/api/admins/check', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        if (req.user.email === 'jesseegwuatu@gmail.com') {
            return res.json({ isAdmin: true, firstLogin: false });
        }

        const snapshot = await db.ref(`admins/${uid}`).once('value');
        const adminData = snapshot.val();

        if (!adminData) {
            return res.json({ isAdmin: false });
        }

        res.json({
            isAdmin: true,
            firstLogin: adminData.firstLogin || false,
            role: adminData.role || 'admin'
        });
    } catch (error) {
        console.error('Check admin error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admins', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        if (req.user.email !== 'jesseegwuatu@gmail.com') {
            const adminCheck = await db.ref(`admins/${uid}`).once('value');
            if (!adminCheck.exists()) {
                return res.status(403).json({ success: false, message: 'Super admin access required' });
            }
        }

        const snapshot = await db.ref('admins').once('value');
        const admins = snapshot.val() || {};

        const adminList = Object.entries(admins).map(([id, data]) => ({
            uid: id,
            ...data
        }));

        res.json({ success: true, admins: adminList });
    } catch (error) {
        console.error('Get admins error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admins', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        if (req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Super admin access required' });
        }

        const { email, displayName, firstLogin = true } = req.body;

        if (!email) {
            return res.status(400).json({ success: false, message: 'Email required' });
        }

        let userRecord;
        try {
            userRecord = await admin.auth().getUserByEmail(email);
        } catch (authError) {
            if (authError.code === 'auth/user-not-found') {
                return res.status(404).json({ success: false, message: 'User not found. User must have an account first.' });
            }
            throw authError;
        }

        const existingSnapshot = await db.ref(`admins/${userRecord.uid}`).once('value');
        if (existingSnapshot.exists()) {
            return res.status(400).json({ success: false, message: 'User is already an admin' });
        }

        await db.ref(`admins/${userRecord.uid}`).set({
            email: userRecord.email,
            displayName: displayName || userRecord.displayName || 'Admin',
            role: 'admin',
            firstLogin: firstLogin,
            createdAt: Date.now(),
            addedBy: uid
        });

        await sendNotification(userRecord.uid, 'Admin Access Granted',
            `You have been granted administrator access to Shop Good.`,
            'info', { role: 'admin' }
        );

        res.json({ success: true, message: 'Admin added successfully' });
    } catch (error) {
        console.error('Add admin error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admins/:adminUid', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { adminUid } = req.params;

        if (req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Super admin access required' });
        }

        const adminSnapshot = await db.ref(`admins/${adminUid}`).once('value');
        const adminData = adminSnapshot.val();
        if (adminData && adminData.email === 'jesseegwuatu@gmail.com') {
            return res.status(400).json({ success: false, message: 'Cannot remove super admin' });
        }

        await db.ref(`admins/${adminUid}`).remove();

        await sendNotification(adminUid, 'Admin Access Revoked',
            `Your administrator access to Shop Good has been revoked.`,
            'info', { role: 'customer' }
        );

        res.json({ success: true, message: 'Admin removed successfully' });
    } catch (error) {
        console.error('Remove admin error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// ANALYTICS ROUTES
// ========================================

app.get('/api/analytics', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { period = '30' } = req.query;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const periodDays = period === 'all' ? Infinity : parseInt(period);
        const cutoff = periodDays === Infinity ? 0 : Date.now() - (periodDays * 24 * 60 * 60 * 1000);

        const ordersSnapshot = await db.ref('orders').once('value');
        const ordersData = ordersSnapshot.val() || {};

        const orders = Object.entries(ordersData)
            .filter(([id, data]) => !periodDays || (data.createdAt || 0) >= cutoff)
            .map(([id, data]) => ({
                id,
                ...data
            }));

        res.json({ success: true, orders });
    } catch (error) {
        console.error('Get analytics error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// SETTINGS ROUTES
// ========================================

app.get('/api/settings', async (req, res) => {
    try {
        const snapshot = await db.ref('settings/store').once('value');
        const settings = snapshot.val() || {};

        res.json({ success: true, settings });
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/settings', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const { storeName, storeEmail, storePhone, storeAddress, deliveryFee, minCOD } = req.body;

        const updates = {};
        if (storeName !== undefined) updates.storeName = storeName;
        if (storeEmail !== undefined) updates.storeEmail = storeEmail;
        if (storePhone !== undefined) updates.storePhone = storePhone;
        if (storeAddress !== undefined) updates.storeAddress = storeAddress;
        if (deliveryFee !== undefined) updates.deliveryFee = deliveryFee;
        if (minCOD !== undefined) updates.minCOD = minCOD;
        updates.updatedAt = Date.now();

        await db.ref('settings/store').update(updates);

        res.json({ success: true, message: 'Settings updated' });
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// AUDIT LOG ROUTES
// ========================================

app.get('/api/audit-logs', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;

        const adminCheck = await db.ref(`admins/${uid}`).once('value');
        if (!adminCheck.exists() && req.user.email !== 'jesseegwuatu@gmail.com') {
            return res.status(403).json({ success: false, message: 'Admin access required' });
        }

        const snapshot = await db.ref('audit_logs').once('value');
        const logs = snapshot.val() || {};

        const logList = Object.entries(logs).map(([id, data]) => ({
            id,
            ...data
        }));

        logList.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        res.json({ success: true, logs: logList });
    } catch (error) {
        console.error('Get audit logs error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/audit-logs', verifyAuth, async (req, res) => {
    try {
        const uid = req.user.uid;
        const { action, details, adminEmail, adminUid } = req.body;

        const logRef = db.ref('audit_logs').push();
        await logRef.set({
            action,
            details,
            adminEmail: adminEmail || req.user.email,
            adminUid: adminUid || uid,
            timestamp: Date.now()
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Create audit log error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ========================================
// START SERVER
// ========================================
const PORT = process.env.PORT || 3000;

// Only listen if not running on Vercel
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`🚀 Shop Good API Server running on port ${PORT}`);
        console.log(`📡 Firebase Database: ${FIREBASE_DATABASE_URL}`);
    });
}

module.exports = app;