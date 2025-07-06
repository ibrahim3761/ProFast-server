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
    const trackingsCollection = database.collection("trackings");

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

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;

      const query = { email };
      const user = await userCollection.findOne(query);

      
      if (!user || user.role !== "admin") {
        return res.status(401).send({ message: "forbidden access" });
      }
      next();
    };
    const verifyRider = async (req, res, next) => {
      const email = req.decoded.email;

      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "rider") {
        return res.status(401).send({ message: "forbidden access" });
      }
      next();
    };

    // GET /users/search?email=partial@example
    app.get("/users/search", verfyFBtoken, verifyAdmin, async (req, res) => {
      const emailQuery = req.query.email;

      if (!emailQuery) {
        return res.status(400).json({ error: "Email query is required" });
      }

      try {
        const regex = new RegExp(emailQuery, "i"); // case-insensitive
        const users = await userCollection
          .find({ email: { $regex: regex } })
          .project({ email: 1, role: 1, created_at: 1 })
          .limit(10) // optional: limit results
          .toArray();

        if (users.length === 0) {
          return res.status(404).json({ error: "No matching users found" });
        }

        res.status(200).json(users);
      } catch (error) {
        console.error("Error searching users:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    // GET /users/:email/role
    app.get("/users/:email/role", verfyFBtoken, async (req, res) => {
      const email = req.params.email;

      try {
        const user = await userCollection.findOne({ email });

        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }

        res.status(200).json({ role: user.role || "user" }); // default fallback
      } catch (error) {
        console.error("Error fetching user role:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

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

    const { ObjectId } = require("mongodb");

    app.patch(
      "/users/:id/role",
      verfyFBtoken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { role } = req.body; // expect "admin" or "user"

        try {
          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role } }
          );

          res.status(200).json({
            message: `User role updated to ${role}`,
            modifiedCount: result.modifiedCount,
          });
        } catch (error) {
          console.error("Error updating user role:", error);
          res.status(500).json({ error: "Failed to update user role" });
        }
      }
    );

    // parcel get api
    app.get("/parcels", verfyFBtoken, async (req, res) => {
      try {
        const { email, payment_status, delivery_status } = req.query;

        const query = {};

        if (email) {
          query.created_by = email;
        }

        if (payment_status) {
          query.payment_status = payment_status;
        }

        if (delivery_status) {
          query.delivery_status = delivery_status;
        }

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

    app.get("/parcels/user/:email", async (req, res) => {
      try {
        const userEmail = req.params.email;
        const parcels = await parcelsCollection
          .find({ created_by: userEmail })
          .toArray();

        // For each parcel, fetch latest tracking update (or full history if you want)
        const parcelsWithTracking = await Promise.all(
          parcels.map(async (parcel) => {
            const trackingUpdates = await trackingsCollection
              .find({ tracking_id: parcel.tracking_id })
              .sort({ timestamp: -1 }) // latest first
              .toArray();

            return {
              ...parcel,
              latestTracking: trackingUpdates[0] || null,
              trackingHistory: trackingUpdates, // optional if you want full history
            };
          })
        );

        res.status(200).json(parcelsWithTracking);
      } catch (error) {
        console.error("Error fetching parcels with tracking:", error);
        res.status(500).json({ message: "Internal server error" });
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
    app.patch(
      "/parcels/:id/assign",
      verfyFBtoken,
      verifyAdmin,
      async (req, res) => {
        try {
          const parcelId = req.params.id;
          const { riderId, riderName, riderEmail } = req.body;

          if (!riderId || !riderName || !riderEmail) {
            return res.status(400).json({
              error: "riderId, riderName and riderEmail are required",
            });
          }

          // 1. Update the parcel: assign rider and set delivery status
          const updateParcelResult = await parcelsCollection.updateOne(
            { _id: new ObjectId(parcelId) },
            {
              $set: {
                assigned_rider: {
                  id: riderId,
                  name: riderName,
                  email: riderEmail,
                },
                delivery_status: "rider_assigned",
                assigned_at: new Date(),
              },
            }
          );

          if (updateParcelResult.matchedCount === 0) {
            return res.status(404).json({ error: "Parcel not found" });
          }

          // 2. Update the rider’s work_status to 'in_delivery'
          const updateRiderResult = await ridersCollection.updateOne(
            { _id: new ObjectId(riderId) },
            { $set: { work_status: "in_delivery" } }
          );

          if (updateRiderResult.matchedCount === 0) {
            return res.status(404).json({ error: "Rider not found" });
          }

          res.status(200).json({
            message: "Rider assigned and status updated successfully",
          });
        } catch (error) {
          console.error("Error assigning rider and updating status:", error);
          res
            .status(500)
            .json({ error: "Failed to assign rider or update status" });
        }
      }
    );

    app.patch("/parcels/:id/status", verfyFBtoken, async (req, res) => {
      const { id } = req.params;
      const { status } = req.body;

      if (!["in_transit", "delivered"].includes(status)) {
        return res.status(400).json({ error: "Invalid status" });
      }

      const updateFields = {
        delivery_status: status,
      };

      // Add timestamp fields based on the status
      if (status === "in_transit") {
        updateFields.in_transit_at = new Date();
      } else if (status === "delivered") {
        updateFields.delivered_at = new Date();
      }

      try {
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateFields }
        );

        res.status(200).json({
          message: `Parcel status updated to ${status}`,
          modifiedCount: result.modifiedCount,
        });
      } catch (error) {
        console.error("Failed to update parcel status:", error);
        res.status(500).json({ error: "Failed to update status" });
      }
    });

    // PATCH /parcels/:id/cashout
    app.patch("/parcels/:id/cashout", verfyFBtoken, async (req, res) => {
      const { id } = req.params;

      try {
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).json({ error: "Parcel not found" });
        }

        if (parcel.cashed_out_status === "cashed_out") {
          return res.status(400).json({ error: "Parcel already cashed out" });
        }

        // Calculate rider earning
        const isSameDistrict =
          parcel.sender_district.toLowerCase() ===
          parcel.receiver_district.toLowerCase();

        const percentage = isSameDistrict ? 0.8 : 0.3;
        const earning = Math.round(parcel.cost * percentage); // round off

        // Update parcel as cashed out
        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              cashed_out_status: "cashed_out",
              cashed_out_at: new Date(),
            },
          }
        );

        // Update rider earnings
        const riderEmail = parcel.assigned_rider?.email;
        if (riderEmail) {
          await ridersCollection.updateOne(
            { email: riderEmail },
            {
              $inc: { total_earnings: earning },
            }
          );
        }

        res.status(200).json({
          message: `Parcel cashed out successfully. Rider earned ৳${earning}`,
          earning,
        });
      } catch (error) {
        console.error("Cashout failed:", error);
        res.status(500).json({ error: "Failed to cashout parcel" });
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
    app.get("/riders/pending", verfyFBtoken, verifyAdmin, async (req, res) => {
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

    app.get("/riders/active", verfyFBtoken, verifyAdmin, async (req, res) => {
      try {
        const { district } = req.query;

        const filter = {
          status: "active",
          ...(district && {
            warehouse: { $regex: new RegExp(`^${district}$`, "i") }, // match against 'warehouse'
          }),
        };

        const activeRiders = await ridersCollection
          .find(filter)
          .sort({ created_at: -1 })
          .toArray();

        res.status(200).json(activeRiders);
      } catch (error) {
        console.error("Error fetching active riders:", error);
        res.status(500).json({ error: "Failed to fetch active riders" });
      }
    });

    // GET /riders/parcels?email=example@gmail.com
    app.get("/riders/parcels", verfyFBtoken, verifyRider, async (req, res) => {
      try {
        const riderEmail = req.query.email;

        if (!riderEmail) {
          return res.status(400).json({ error: "Rider email is required" });
        }

        const query = {
          "assigned_rider.email": riderEmail,
          delivery_status: { $in: ["rider_assigned", "in_transit"] },
        };

        const parcels = await parcelsCollection
          .find(query)
          .sort({ creation_date: -1 })
          .toArray();

        res.status(200).json(parcels);
      } catch (error) {
        console.error("Error fetching rider parcels:", error);
        res.status(500).json({ error: "Failed to fetch rider parcels" });
      }
    });

    // GET /riders/parcels/completed?email=...
    app.get(
      "/riders/parcels/completed",
      verfyFBtoken,
      verifyRider,
      async (req, res) => {
        try {
          const { email } = req.query;

          if (!email) {
            return res
              .status(400)
              .json({ error: "Email query parameter is required" });
          }

          const query = {
            "assigned_rider.email": email,
            delivery_status: { $in: ["delivered", "service_center_delivered"] },
          };

          const completedParcels = await parcelsCollection
            .find(query)
            .sort({ updated_at: -1 }) // if you track updates
            .toArray();

          res.status(200).json(completedParcels);
        } catch (error) {
          console.error("Error fetching completed parcels:", error);
          res.status(500).json({ error: "Failed to fetch completed parcels" });
        }
      }
    );

    app.patch("/riders/:id", async (req, res) => {
      const { id } = req.params;
      const { status, email } = req.body;
      if (!["active", "cancelled", "deactivated"].includes(status)) {
        return res.status(400).send({ message: "Invalid status" });
      }

      const result = await ridersCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );

      if (status === "active") {
        const userQuery = { email };
        const userUpdatedoc = {
          $set: {
            role: "rider",
          },
        };
        const roleResult = await userCollection.updateOne(
          userQuery,
          userUpdatedoc
        );
        console.log(roleResult.modifiedCount);
      }
      res.send(result);
    });

    // tracking related api
    app.get("/trackings/:trackingId", async (req, res) => {
      try {
        const trackingId = req.params.trackingId;

        const updates = await trackingsCollection
          .find({ tracking_id: trackingId })
          .sort({ timestamp: 1 }) // oldest first
          .toArray();

        if (!updates.length) {
          return res
            .status(404)
            .json({ message: "No tracking history found." });
        }

        res.status(200).json(updates);
      } catch (error) {
        console.error("Error fetching tracking updates:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    app.post("/trackings", async (req, res) => {
      try {
        const update = req.body;

        if (!update.tracking_id || !update.status) {
          return res
            .status(400)
            .json({ message: "tracking_id and status are required." });
        }

        update.timestamp = new Date();
        update.location = update.location || "Unknown";
        update.updated_by = update.updated_by || "system";

        const result = await trackingsCollection.insertOne(update);
        res.status(201).json({
          message: "Tracking update added.",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Error adding tracking update:", error);
        res.status(500).json({ message: "Internal server error" });
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
