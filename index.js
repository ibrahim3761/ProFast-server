const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json()); // for parsing application/json

//
//

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.thvamxq.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const database = client.db("parcelDB"); // You can rename "parcelDB" if you want
    const parcelsCollection = database.collection("parcels");

    app.get("/parcels", async (req, res) => {
      const parcels = await parcelsCollection.find().toArray();
      res.send(parcels);
    });

    // parcel get api
    app.get("/parcels", async (req, res) => {
      try {
        const userEmail = req.query.email;
        const query = userEmail ? { created_by: userEmail } : {};

        const parcels = await parcelsCollection
          .find(query)
          .sort({ creation_date: -1 })
          .toArray();

        res.status(200).json(parcels);
      } catch (error) {
        console.error("Error fetching parcels:", error);
        res.status(500).json({ error: "Failed to fetch parcels" });
      }
    });

    // parcel post api
    app.post("/parcels", async (req, res) => {
      try {
        const parcel = req.body;
        const result = await parcelsCollection.insertOne(parcel);
        res.status(201).json({ insertedId: result.insertedId });
      } catch (error) {
        console.error("Error saving parcel:", error);
        res.status(500).json({ error: "Failed to save parcel" });
      }
    });

    // parcel delete
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };

        const result = await parcelsCollection.deleteOne(query);

        if (result.deletedCount === 1) {
          res
            .status(200)
            .json({ message: "Parcel deleted successfully", deletedCount: 1 });
        } else {
          res
            .status(404)
            .json({ message: "Parcel not found", deletedCount: 0 });
        }
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).json({ error: "Failed to delete parcel" });
      }
    });
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

// Test Route
app.get("/", (req, res) => {
  res.send("Parcel server is running 🚀");
});

// Start Server
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
