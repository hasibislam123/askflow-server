const express = require('express')
const cors = require('cors')
const app = express()
require('dotenv').config();

const { MongoClient, ServerApiVersion } = require('mongodb');



const port = process.env.PORT || 3000


// middleware

app.use(express.json())
app.use(cors())


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@ggbd.znymale.mongodb.net/?appName=ggbd`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
   serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true,
   }
});


async function run() {
   try {
      // Connect the client to the server	(optional starting in v4.7)
      await client.connect();

      const db = client.db('askflow_db');
      const parcelsColletion = db.collection('parcels');

      // parcelApi
      // Get
      app.get('/parcels', async (req, res) => {
         const query = {}
         const {email} = req.query;

         if(email){
            query.senderEmail = email;
         }

         const cursor = parcelsColletion.find(query);
         const result = await cursor.toArray();
         res.send(result);
      })

      // Post
      app.post('/parcels', async (req, res) => {
         const parcel = req.body;
         const result = await parcelsColletion.insertOne(parcel)
         res.send(result)
      })


      // Send a ping to confirm a successful connection
      await client.db("admin").command({ ping: 1 });
      console.log("Pinged your deployment. You successfully connected to MongoDB!");
   } finally {
      // Ensures that the client will close when you finish/error
      //  await client.close();
   }
}
run().catch(console.dir);

app.get('/', (req, res) => {
   res.send(' askFlow in Hello World!')
})

app.listen(port, () => {
   console.log(`Example app listening on port ${port}`)
})
