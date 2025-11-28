// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET || '');
const path = require('path');

const serviceAccountPath = path.join(__dirname, process.env.FIREBASE_ADMIN_JSON || 'askflow-firebase-adminsdk.json');

try {
   const serviceAccount = require(serviceAccountPath);
   admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
   });
} catch (err) {
   console.warn('Firebase admin init failed — check FIREBASE_ADMIN_JSON path and file. Continuing without Firebase for now.', err.message);
}

const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(cors());
app.use(express.json());

// ===== Utility helpers =====
function generateTrackingId() {
   const prefix = "PRCL";
   const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
   const random = crypto.randomBytes(3).toString("hex").toUpperCase();
   return `${prefix}-${date}-${random}`;
}

const isValidObjectId = (id) => {
   if (!id) return false;
   try {
      return ObjectId.isValid(id) && (String(new ObjectId(id)) === id || true);
   } catch {
      return false;
   }
};

const asyncHandler = (fn) => (req, res, next) => {
   Promise.resolve(fn(req, res, next)).catch(next);
};

// ===== Firebase token verification middleware =====
const verifyFirebaseToken = asyncHandler(async (req, res, next) => {
   const authHeader = req.headers.authorization;
   if (!authHeader) {
      return res.status(401).json({ message: 'Unauthorized access: missing authorization header' });
   }

   const parts = authHeader.split(' ');
   if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({ message: 'Unauthorized access: invalid authorization format' });
   }

   const idToken = parts[1];

   try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      req.decoded_email = decoded.email;
      req.decoded_user = decoded; // optional: useful info
      next();
   } catch (err) {
      console.error('verifyFirebaseToken error:', err.message);
      return res.status(401).json({ message: 'Unauthorized access: token invalid or expired' });
   }
});

// ===== MongoDB client setup =====
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ggbd.znymale.mongodb.net/?appName=ggbd`;
const client = new MongoClient(uri, {
   serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
   }
});

async function run() {
   await client.connect();
   const db = client.db(process.env.DB_NAME || 'askflow_db');
   const userCollection = db.collection('users');
   const parcelsCollection = db.collection('parcels');
   const paymentCollection = db.collection('payments');
   const ridersCollection = db.collection('riders');
   // নতুন ট্র্যাকিং কালেকশন যোগ করা হলো
   const trackingsCollection = db.collection('trackings');

   // ট্র্যাকিং লগ তৈরি করার ফাংশন
   const logTracking = async (trackingId, status) => {
      const log = {
         trackingId,
         status,
         details: status.split('_').join(' '),
         createdAt: new Date()
      }
      const result = await trackingsCollection.insertOne(log);
      return result;
   }

   // ===== verifyAdmin middleware (uses DB) =====
   const verifyAdmin = asyncHandler(async (req, res, next) => {
      const email = req.decoded_email;
      if (!email) {
         return res.status(401).json({ message: 'Unauthorized: missing decoded email' });
      }
      const user = await userCollection.findOne({ email });
      if (!user || user.role !== 'admin') {
         return res.status(403).json({ message: 'Forbidden access' });
      }
      next();
   });

   // ====== USER ROUTES ======
   app.get('/users', verifyFirebaseToken, asyncHandler(async (req, res) => {
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
         query.$or = [
            { displayName: { $regex: searchText, $options: 'i' } },
            { email: { $regex: searchText, $options: 'i' } }
         ];
      }
      const limit = parseInt(req.query.limit) || 5;
      const cursor = userCollection.find(query).sort({ createdAt: -1 }).limit(limit);
      const result = await cursor.toArray();
      res.json(result);
   }));

   app.get('/users/:id', asyncHandler(async (req, res) => {
      const id = req.params.id;
      if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid user id' });
      const user = await userCollection.findOne({ _id: new ObjectId(id) });
      res.json(user || {});
   }));

   app.get('/users/:email/role', asyncHandler(async (req, res) => {
      const email = req.params.email;
      if (!email) return res.status(400).json({ role: 'user' });
      const user = await userCollection.findOne({ email });
      res.json({ role: user?.role || 'user' });
   }));

   app.post('/users', asyncHandler(async (req, res) => {
      const user = req.body;
      if (!user || !user.email) return res.status(400).json({ message: 'User data with email required' });

      user.role = user.role || 'user';
      user.createdAt = new Date();

      const existing = await userCollection.findOne({ email: user.email });
      if (existing) return res.status(200).json({ message: 'user exists' });

      const result = await userCollection.insertOne(user);
      res.status(201).json(result);
   }));

   app.patch('/users/:id/role', verifyFirebaseToken, verifyAdmin, asyncHandler(async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid user id' });
      if (!role) return res.status(400).json({ message: 'role is required in body' });

      const query = { _id: new ObjectId(id) };
      const update = { $set: { role } };
      const result = await userCollection.updateOne(query, update);
      res.json(result);
   }));

   // ====== PARCEL ROUTES ======
   app.get('/parcels', async (req, res) => {
      const query = {}
      const { email, deliveryStatus } = req.query;

      // /parcels?email=''&
      if (email) {
         query.senderEmail = email;
      }

      if (deliveryStatus) {
         query.deliveryStatus = deliveryStatus
      }

      const options = { sort: { createdAt: -1 } }

      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
   })

   app.get('/parcels/rider', async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {}

      if (riderEmail) {
         query.riderEmail = riderEmail
      }
      if (deliveryStatus !== 'parcel_delivered') {
         // query.deliveryStatus = {$in: ['driver_assigned', 'rider_arriving']}
         query.deliveryStatus = { $nin: ['parcel_delivered'] }
      }
      else {
         query.deliveryStatus = deliveryStatus;
      }

      const cursor = parcelsCollection.find(query)
      const result = await cursor.toArray();
      res.send(result);
   })

   app.get('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }
      const result = await parcelsCollection.findOne(query);
      res.send(result);
   })

   app.post('/parcels', async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId();
      // parcel created time
      parcel.createdAt = new Date();
      parcel.trackingId = trackingId;

      logTracking(trackingId, 'parcel_created');

      const result = await parcelsCollection.insertOne(parcel);
      res.send(result)
   })

   // TODO: rename this to be specific like /parcels/:id/assign
   app.patch('/parcels/:id', async (req, res) => {
      const { riderId, riderName, riderEmail, trackingId } = req.body;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }

      const updatedDoc = {
         $set: {
            deliveryStatus: 'driver_assigned',
            riderId: riderId,
            riderName: riderName,
            riderEmail: riderEmail
         }
      }

      const result = await parcelsCollection.updateOne(query, updatedDoc)

      // update rider information
      const riderQuery = { _id: new ObjectId(riderId) }
      const riderUpdatedDoc = {
         $set: {
            workStatus: 'in_delivery'
         }
      }
      const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);

      // log  tracking
      logTracking(trackingId, 'driver_assigned')

      res.send(riderResult);

   })

   app.patch('/parcels/:id/status', async (req, res) => {
      const { deliveryStatus, riderId, trackingId } = req.body;

      const query = { _id: new ObjectId(req.params.id) }
      const updatedDoc = {
         $set: {
            deliveryStatus: deliveryStatus
         }
      }

      if (deliveryStatus === 'parcel_delivered') {
         // update rider information
         const riderQuery = { _id: new ObjectId(riderId) }
         const riderUpdatedDoc = {
            $set: {
               workStatus: 'available'
            }
         }
         const riderResult = await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);
      }

      const result = await parcelsCollection.updateOne(query, updatedDoc)
      // log tracking
      logTracking(trackingId, deliveryStatus);

      res.send(result);
   })

   app.delete('/parcels/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) }

      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
   })
   // ====== PAYMENT ROUTES ======
   app.post('/payment-checkout-session', asyncHandler(async (req, res) => {
      const paymentInfo = req.body;
      if (!paymentInfo || !paymentInfo.cost || !paymentInfo.parcelId || !paymentInfo.senderEmail) {
         return res.status(400).json({ message: 'Missing paymentInfo fields' });
      }

      // পার্সেল থেকে ট্র্যাকিং আইডি তুলে আনা হলো, যা পেমেন্ট এর পরে লাগবে
      let trackingId = '';
      if (isValidObjectId(paymentInfo.parcelId)) {
         const parcel = await parcelsCollection.findOne({ _id: new ObjectId(paymentInfo.parcelId) });
         trackingId = parcel?.trackingId || '';
      }

      const amount = Math.round(parseFloat(paymentInfo.cost) * 100);
      const session = await stripe.checkout.sessions.create({
         line_items: [
            {
               price_data: {
                  currency: 'usd',
                  unit_amount: amount,
                  product_data: {
                     name: `Please pay for: ${paymentInfo.parcelName || 'parcel'}`
                  }
               },
               quantity: 1,
            },
         ],
         mode: 'payment',
         metadata: {
            parcelId: paymentInfo.parcelId,
            parcelName: paymentInfo.parcelName || '',
            // ট্র্যাকিং আইডি মেটাডাটায় যোগ করা হলো
            trackingId: trackingId
         },
         customer_email: paymentInfo.senderEmail,
         success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
         cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      res.json({ url: session.url });
   }));

   // compatibility route (old) - আপডেট করা হয়নি, কেননা নতুন রুটটি ব্যবহার করা হচ্ছে।

   app.patch('/payment-success', asyncHandler(async (req, res) => {
      const sessionId = req.query.session_id;
      if (!sessionId) return res.status(400).json({ message: 'session_id query param required' });

      const session = await stripe.checkout.sessions.retrieve(sessionId);
      if (!session) return res.status(404).json({ message: 'Stripe session not found' });

      const transactionId = session.payment_intent;
      const trackingId = session.metadata?.trackingId;
      const paymentExist = await paymentCollection.findOne({ transactionId });

      if (paymentExist) {
         return res.json({
            message: 'already exists',
            transactionId,
            trackingId: paymentExist.trackingId
         });
      }

      if (session.payment_status === 'paid') {
         const parcelId = session.metadata?.parcelId;
         if (parcelId && isValidObjectId(parcelId)) {
            await parcelsCollection.updateOne(
               { _id: new ObjectId(parcelId) },
               { $set: { paymentStatus: 'paid', deliveryStatus: 'pending-pickup', trackingId, updatedAt: new Date() } }
            );
         }

         const payment = {
            amount: session.amount_total / 100,
            currency: session.currency,
            customerEmail: session.customer_email,
            parcelId: session.metadata?.parcelId,
            parcelName: session.metadata?.parcelName,
            transactionId: session.payment_intent,
            paymentStatus: session.payment_status,
            paidAt: new Date(),
            trackingId
         };

         const resultPayment = await paymentCollection.insertOne(payment);


         await logTracking(trackingId, 'parcel_paid');

         return res.json({
            success: true,
            trackingId,
            transactionId,
            paymentInfo: resultPayment
         });
      }

      res.json({ success: false });
   }));

   app.get('/payments', verifyFirebaseToken, asyncHandler(async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
         if (email !== req.decoded_email) {
            return res.status(403).json({ message: 'forbidden access' });
         }
         query.customerEmail = email;
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.json(result);
   }));

   // ====== RIDER ROUTES ======
   app.get('/riders', asyncHandler(async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      if (status) query.status = status;
      if (district) query.district = district;
      if (workStatus) query.workStatus = workStatus;

      const cursor = ridersCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.json(result);
   }));

   app.post('/riders', asyncHandler(async (req, res) => {
      const rider = req.body;
      if (!rider || !rider.email) return res.status(400).json({ message: 'Rider data with email required' });
      rider.status = 'pending';
      rider.createdAt = new Date();
      const result = await ridersCollection.insertOne(rider);
      res.status(201).json(result);
   }));

   app.patch('/riders/:id', verifyFirebaseToken, verifyAdmin, asyncHandler(async (req, res) => {
      const id = req.params.id;
      const { status, email } = req.body;
      if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid rider id' });
      if (!status) return res.status(400).json({ message: 'status field required' });

      const query = { _id: new ObjectId(id) };
      const updatedDoc = { $set: { status, workStatus: status === 'approved' ? 'available' : 'pending', updatedAt: new Date() } };
      const result = await ridersCollection.updateOne(query, updatedDoc);

      if (status === 'approved' && email) {
         await userCollection.updateOne({ email }, { $set: { role: 'rider' } });
      }

      res.json(result);
   }));

   // ====== TRACKING ROUTES (নতুন যোগ করা) ======
   app.get('/trackings/:trackingId/logs', asyncHandler(async (req, res) => {
      const trackingId = req.params.trackingId;
      if (!trackingId) return res.status(400).json({ message: 'Tracking ID is required' });

      const query = { trackingId };
      // সময় অনুযায়ী সাজানো
      const result = await trackingsCollection.find(query).sort({ createdAt: 1 }).toArray();
      res.json(result);
   }));


   // ====== Basic ping & readiness ======
   app.get('/', (req, res) => res.send('askFlow — Hello World!'));

   // ====== Global error handler ======
   app.use((err, req, res, next) => {
      console.error('Unhandled error:', err);
      res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
   });

   // Ping DB
   await client.db("admin").command({ ping: 1 });
   console.log("Connected to MongoDB successfully");
}

run().catch(err => {
   console.error('Failed to run server:', err);
   process.exit(1);
});

// Start server
app.listen(port, () => {
   console.log(`Server listening on port ${port}`);
});