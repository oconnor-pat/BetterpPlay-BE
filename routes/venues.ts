import { Router, Request, Response } from "express";
import Venue from "../models/venue";
import { requireAdmin } from "../middleware/auth";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const { type, city, state, isActive } = req.query;

    const filter: any = {};

    if (type) filter.type = type;
    if (city) filter["address.city"] = { $regex: city, $options: "i" };
    if (state) filter["address.state"] = state;
    if (isActive !== undefined) filter.isActive = isActive === "true";

    const venues = await Venue.find(filter).sort({ name: 1 });
    res.status(200).json(venues);
  } catch (error) {
    console.error("Error fetching venues:", error);
    res.status(500).json({ message: "Failed to fetch venues" });
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const venue = await Venue.findById(req.params.id);
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
    }
    res.status(200).json(venue);
  } catch (error) {
    console.error("Error fetching venue:", error);
    res.status(500).json({ message: "Failed to fetch venue" });
  }
});

router.get("/:id/subvenues", async (req: Request, res: Response) => {
  try {
    const venue = await Venue.findById(req.params.id);
    if (!venue) {
      return res.status(404).json({ message: "Venue not found" });
    }
    res.status(200).json(venue.subVenues);
  } catch (error) {
    console.error("Error fetching sub-venues:", error);
    res.status(500).json({ message: "Failed to fetch sub-venues" });
  }
});

router.post("/", requireAdmin, async (req: Request, res: Response) => {
  try {
    const {
      name,
      type,
      address,
      coordinates,
      subVenues,
      amenities,
      contactEmail,
      contactPhone,
      website,
      imageUrl,
      operatingHours,
    } = req.body;

    if (!name || !type || !address || !coordinates) {
      return res.status(400).json({
        message: "Missing required fields: name, type, address, coordinates",
      });
    }

    const newVenue = await Venue.create({
      name,
      type,
      address,
      coordinates,
      subVenues: subVenues || [],
      amenities: amenities || [],
      contactEmail,
      contactPhone,
      website,
      imageUrl,
      operatingHours,
      isActive: true,
    });

    res.status(201).json(newVenue);
  } catch (error) {
    console.error("Error creating venue:", error);
    res.status(500).json({ message: "Failed to create venue" });
  }
});

router.put(
  "/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const venueId = req.params.id;
      const venue = await Venue.findById(venueId);

      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const updateFields = [
        "name",
        "type",
        "address",
        "coordinates",
        "subVenues",
        "amenities",
        "contactEmail",
        "contactPhone",
        "website",
        "imageUrl",
        "operatingHours",
        "isActive",
      ];

      updateFields.forEach((field) => {
        if (req.body[field] !== undefined) {
          (venue as any)[field] = req.body[field];
        }
      });

      await venue.save();
      res.status(200).json(venue);
    } catch (error) {
      console.error("Error updating venue:", error);
      res.status(500).json({ message: "Failed to update venue" });
    }
  },
);

router.delete(
  "/:id",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const venueId = req.params.id;
      const venue = await Venue.findById(venueId);

      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      await Venue.findByIdAndDelete(venueId);
      res.sendStatus(204);
    } catch (error) {
      console.error("Error deleting venue:", error);
      res.status(500).json({ message: "Failed to delete venue" });
    }
  },
);

export default router;
