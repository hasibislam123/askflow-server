const express = require('express')
const cors = require('cors');
const app = express();
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET);

const crypto = require("crypto");

const admin = require("firebase-admin");


const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf8')
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});


function generateTrackingId() {
    const prefix = "PRCL"; // your brand prefix
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
    const random = crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char random hex

    return `${prefix}-${date}-${random}`;
}

// middleware
app.use(express.json());
app.use(cors({
    origin: [
        'http://localhost:5173',
        'http://localhost:3000',
        process.env.SITE_DOMAIN
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

const verifyFBToken = async (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).send({ message: 'unauthorized access' })
    }

    try {
        const idToken = token.split(' ')[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        console.log('decoded in the token', decoded);
        req.decoded_email = decoded.email;
        next();
    }
    catch (err) {
        console.error('Firebase token verification error:', err);
        return res.status(401).send({ message: 'unauthorized access', error: err.message })
    }


}

const uri = `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@ggbd.znymale.mongodb.net/${process.env.DB_NAME}?retryWrites=true&w=majority`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let db;
let userCollection;
let parcelsCollection;
let paymentCollection;
let ridersCollection;
let trackingsCollection;

// Connect to MongoDB
async function connectDB() {
    if (db) return;
    try {
        await client.connect();
        db = client.db('askflow_db');
        userCollection = db.collection('users');
        parcelsCollection = db.collection('parcels');
        paymentCollection = db.collection('payments');
        ridersCollection = db.collection('riders');
        trackingsCollection = db.collection('trackings');
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('MongoDB connection error:', error);
    }
}

// Initialize connection
connectDB();

// Middleware functions

const verifyAdmin = async (req, res, next) => {
    await connectDB();
    const email = req.decoded_email;
    const query = { email };
    const user = await userCollection.findOne(query);

    if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' });
    }

    next();
}

const verifyRider = async (req, res, next) => {
    await connectDB();
    const email = req.decoded_email;
    const query = { email };
    const user = await userCollection.findOne(query);

    if (!user || user.role !== 'rider') {
        return res.status(403).send({ message: 'forbidden access' });
    }

    next();
}

const logTracking = async (trackingId, status) => {
    await connectDB();
    const log = {
        trackingId,
        status,
        details: status.split('_').join(' '),
        createdAt: new Date()
    }
    const result = await trackingsCollection.insertOne(log);
    return result;
}

// Routes

// users related apis
app.get('/users', verifyFBToken, async (req, res) => {
    await connectDB();
            const searchText = req.query.searchText;
            const query = {};

            if (searchText) {
                // query.displayName = {$regex: searchText, $options: 'i'}

                query.$or = [
                    { displayName: { $regex: searchText, $options: 'i' } },
                    { email: { $regex: searchText, $options: 'i' } },
                ]

            }

            const cursor = userCollection.find(query).sort({ createdAt: -1 }).limit(5);
            const result = await cursor.toArray();
            res.send(result);
        });

app.get('/users/:id', async (req, res) => {

})

app.get('/users/:email/role', async (req, res) => {
    await connectDB();
            const email = req.params.email;
            const query = { email }
            const user = await userCollection.findOne(query);
            res.send({ role: user?.role || 'user' })
        })

app.post('/users', async (req, res) => {
    await connectDB();
            const user = req.body;
            user.role = 'user';
            user.createdAt = new Date();
            const email = user.email;
            const userExists = await userCollection.findOne({ email })

            if (userExists) {
                return res.send({ message: 'user exists' })
            }

            const result = await userCollection.insertOne(user);
            res.send(result);
        })

app.patch('/users/:id/role', verifyFBToken, verifyAdmin, async (req, res) => {
    await connectDB();
            const id = req.params.id;
            const roleInfo = req.body;
            const query = { _id: new ObjectId(id) }
            const updatedDoc = {
                $set: {
                    role: roleInfo.role
                }
            }
            const result = await userCollection.updateOne(query, updatedDoc)
            res.send(result);
        })

// parcel api
app.get('/parcels', async (req, res) => {
    await connectDB();
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
    await connectDB();
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
    await connectDB();
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const result = await parcelsCollection.findOne(query);
            res.send(result);
        })

app.get('/parcels/delivery-status/stats', async (req, res) => {
    await connectDB();
            const pipeline = [
                {
                    $group: {
                        _id: '$deliveryStatus',
                        count: { $sum: 1 }
                    }
                },
                {
                    $project: {
                        status: '$_id',
                        count: 1,
                        // _id: 0
                    }
                }
            ]
            const result = await parcelsCollection.aggregate(pipeline).toArray();
            res.send(result);
        })

app.post('/parcels', async (req, res) => {
    await connectDB();
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
    await connectDB();
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
    await connectDB();
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
    await connectDB();
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }

            const result = await parcelsCollection.deleteOne(query);
            res.send(result);
        })


// payment related apis
app.post('/payment-checkout-session', async (req, res) => {
    await connectDB();
            const parcelInfo = req.body;
            const amount = parseInt(parcelInfo.cost) * 100;
            const session = await stripe.checkout.sessions.create({
                line_items: [
                    {
                        price_data: {
                            currency: 'usd',
                            unit_amount: amount,
                            product_data: {
                                name: `Please pay for: ${parcelInfo.parcelName}`
                            }
                        },
                        quantity: 1,
                    },
                ],
                mode: 'payment',
                metadata: {
                    parcelId: parcelInfo.parcelId,
                    trackingId: parcelInfo.trackingId
                },
                customer_email: parcelInfo.senderEmail,
                success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
            })

            res.send({ url: session.url })
        })


app.patch('/payment-success', async (req, res) => {
    await connectDB();
            const sessionId = req.query.session_id;
            const session = await stripe.checkout.sessions.retrieve(sessionId);

            // console.log('session retrieve', session)
            const transactionId = session.payment_intent;
            const query = { transactionId: transactionId }

            const paymentExist = await paymentCollection.findOne(query);
            // console.log(paymentExist);
            if (paymentExist) {
                return res.send({
                    message: 'already exists',
                    transactionId,
                    trackingId: paymentExist.trackingId
                })
            }

            // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
            const trackingId = session.metadata.trackingId;

            if (session.payment_status === 'paid') {
                const id = session.metadata.parcelId;
                const query = { _id: new ObjectId(id) }
                const update = {
                    $set: {
                        paymentStatus: 'paid',
                        deliveryStatus: 'pending-pickup'
                    }
                }

                const result = await parcelsCollection.updateOne(query, update);

                const payment = {
                    amount: session.amount_total / 100,
                    currency: session.currency,
                    customerEmail: session.customer_email,
                    parcelId: session.metadata.parcelId,
                    parcelName: session.metadata.parcelName,
                    transactionId: session.payment_intent,
                    paymentStatus: session.payment_status,
                    paidAt: new Date(),
                    trackingId: trackingId
                }


                const resultPayment = await paymentCollection.insertOne(payment);

                logTracking(trackingId, 'parcel_paid')

                return res.send({
                    success: true,
                    modifyParcel: result,
                    trackingId: trackingId,
                    transactionId: session.payment_intent,
                    paymentInfo: resultPayment
                })
            }
            return res.send({ success: false })
        })

// payment related apis
app.get('/payments', verifyFBToken, async (req, res) => {
    await connectDB();
            const email = req.query.email;
            const query = {}

            // console.log( 'headers', req.headers);

            if (email) {
                query.customerEmail = email;

                // check email address
                if (email !== req.decoded_email) {
                    return res.status(403).send({ message: 'forbidden access' })
                }
            }
            const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
            const result = await cursor.toArray();
            res.send(result);
        })

// riders related apis
app.get('/riders', async (req, res) => {
    await connectDB();
            const { status, district, workStatus } = req.query;
            const query = {}

            if (status) {
                query.status = status;
            }
            if (district) {
                query.district = district
            }
            if (workStatus) {
                query.workStatus = workStatus
            }

            const cursor = ridersCollection.find(query)
            const result = await cursor.toArray();
            res.send(result);
        })

app.get('/riders/delivery-per-day', async (req, res) => {
    await connectDB();
            const email = req.query.email;
            // aggregate on parcel
            const pipeline = [
                {
                    $match: {
                        riderEmail: email,
                        deliveryStatus: "parcel_delivered"
                    }
                },
                {
                    $lookup: {
                        from: "trackings",
                        localField: "trackingId",
                        foreignField: "trackingId",
                        as: "parcel_trackings"
                    }
                },
                {
                    $unwind: "$parcel_trackings"
                },
                {
                    $match: {
                        "parcel_trackings.status": "parcel_delivered"
                    }
                },
                {
                    // convert timestamp to YYYY-MM-DD string
                    $addFields: {
                        deliveryDay: {
                            $dateToString: {
                                format: "%Y-%m-%d",
                                date: "$parcel_trackings.createdAt"
                            }
                        }
                    }
                },
                {
                    // group by date
                    $group: {
                        _id: "$deliveryDay",
                        deliveredCount: { $sum: 1 }
                    }
                }
            ];

            const result = await parcelsCollection.aggregate(pipeline).toArray();
            res.send(result);
        })

app.post('/riders', async (req, res) => {
    await connectDB();
            const rider = req.body;
            rider.status = 'pending';
            rider.createdAt = new Date();

            const result = await ridersCollection.insertOne(rider);
            res.send(result);
        })

app.patch('/riders/:id', verifyFBToken, verifyAdmin, async (req, res) => {
    await connectDB();
            const status = req.body.status;
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const updatedDoc = {
                $set: {
                    status: status,
                    workStatus: 'available'
                }
            }

            const result = await ridersCollection.updateOne(query, updatedDoc);

            if (status === 'approved') {
                const email = req.body.email;
                const userQuery = { email }
                const updateUser = {
                    $set: {
                        role: 'rider'
                    }
                }
                const userResult = await userCollection.updateOne(userQuery, updateUser);
            }

            res.send(result);
        })

// tracking related apis
app.get('/trackings/:trackingId/logs', async (req, res) => {
    await connectDB();
            const trackingId = req.params.trackingId;
            const query = { trackingId };
            const result = await trackingsCollection.find(query).toArray();
            res.send(result);
})

app.get('/', (req, res) => {
    res.send('zap is shifting shifting!')
})

// Export for Vercel serverless
module.exports = app;
