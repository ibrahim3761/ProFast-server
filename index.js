const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
dotenv.config();

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json()); // for parsing application/json

const serviceAccount = require("./firebase-admin-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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
    const paymentsCollection = database.collection("payments");
    const userCollection = database.collection("users");
    const ridersCollection = database.collection("riders");

    // custom middleware
    const verfyFBtoken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "unauthorized access" });
      }
      const token = authHeader.split(" ")[1];

      if (!token) {
        return res.status(401).send({ message: "unauthorized access" });
      }

      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "forbidden access" });
      }
    };

    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const userExists = await userCollection.findOne({ email });
      const now = new Date().toISOString();

      if (userExists) {
        await userCollection.updateOne(
          { email },
          { $set: { last_log_in: now } }
        );

        return res
          .status(200)
          .json({ message: "User already exists", inserted: false });
      }

      const user = req.body;
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // parcel get api
    app.get("/parcels", verfyFBtoken, async (req, res) => {
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

    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid parcel ID" });
        }

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).json({ error: "Parcel not found" });
        }

        res.status(200).json(parcel);
      } catch (error) {
        console.error("Error fetching parcel by ID:", error);
        res.status(500).json({ error: "Failed to fetch parcel" });
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

    // rider relate api
    app.post("/riders", async (req, res) => {
      const riders = req.body;
      const result = await ridersCollection.insertOne(riders);
      res.send(result);
    });

    // GET all pending riders
    app.get("/riders/pending", verfyFBtoken, async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .sort({ created_at: -1 }) // optional: latest first
          .toArray();

        res.status(200).json(pendingRiders);
      } catch (error) {
        console.error("Error fetching pending riders:", error);
        res.status(500).json({ error: "Failed to fetch pending riders" });
      }
    });

    app.get("/riders/active", verfyFBtoken, async (req, res) => {
      try {
        const activeRiders = await ridersCollection
          .find({ status: "active" })
          .sort({ created_at: -1 }) // optional: newest first
          .toArray();

        res.status(200).json(activeRiders);
      } catch (error) {
        console.error("Error fetching active riders:", error);
        res.status(500).json({ error: "Failed to fetch active riders" });
      }
    });

    app.patch("/riders/:id", async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;
      if (!["active", "cancelled", "deactivated"].includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }

      const result = await ridersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );

      res.send(result);
    });

    // tracking related api
    app.post("/tracking", async (req, res) => {
      try {
        const {
          tracking_id,
          parcelId,
          status,
          message,
          updated_by = "",
        } = req.body;

        if (!tracking_id || !parcelId || !status || !message || !updated_by) {
          return res.status(400).json({ error: "All fields are required." });
        }

        const trackingDoc = {
          tracking_id,
          parcelId,
          status,
          message,
          updated_by,
          timestamp: new Date(),
        };

        const result = await trackingCollection.insertOne(trackingDoc);

        res.status(201).json({
          message: "Tracking update saved successfully.",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error inserting tracking update:", error);
        res.status(500).json({ error: "Failed to save tracking update." });
      }
    });

    // payment related api

    // get payment by user
    app.get("/payments", verfyFBtoken, async (req, res) => {
      try {
        const email = req.query.email;
        if (req.decoded.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }
        const query = email ? { email } : {}; // If email is provided, filter by it

        const payments = await paymentsCollection
          .find(query)
          .sort({ paid_at: -1 }) // Sort by newest payment
          .toArray();

        res.status(200).json(payments);
      } catch (error) {
        console.error("Error fetching payments:", error);
        res.status(500).json({ error: "Failed to fetch payments" });
      }
    });

    // payment post api
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, paymentMethod, transactionId } =
          req.body;

        if (
          !parcelId ||
          !email ||
          !amount ||
          !paymentMethod ||
          !transactionId
        ) {
          return res
            .status(400)
            .json({ message: "Missing required payment data" });
        }

        // 1. Mark the parcel as paid
        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid" } }
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .json({ message: "Parcel not found or already marked as paid" });
        }

        // 2. Insert payment history
        const paymentDoc = {
          parcelId,
          email,
          amount,
          paymentMethod,
          transactionId,
          paid_at: new Date(), // for sorting
          paid_at_string: new Date().toISOString(), // for human-readable view
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        // 3. Respond with success
        res.status(201).json({
          message: "Payment recorded successfully",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("Payment processing failed:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
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
