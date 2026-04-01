import { Router, Request, Response } from "express";
import Venue from "../models/venue";
import Booking from "../models/booking";
import Inquiry from "../models/inquiry";
import TimeSlot from "../models/timeSlot";
import User from "../models/user";
import { requireAdmin } from "../middleware/auth";

const router = Router();

const parseTimeString = (timeStr: string): { hour: number; minute: number } => {
  const isPM = timeStr.toLowerCase().includes("pm");
  const isAM = timeStr.toLowerCase().includes("am");

  const cleanTime = timeStr.replace(/\s*(am|pm)\s*/gi, "").trim();
  const [hourStr, minStr] = cleanTime.split(":");
  let hour = parseInt(hourStr, 10);
  const minute = parseInt(minStr, 10) || 0;

  if (isPM && hour !== 12) {
    hour += 12;
  } else if (isAM && hour === 12) {
    hour = 0;
  }

  return { hour, minute };
};

const generateTimeSlots = (
  date: string,
  operatingHours: { open: string; close: string } | null,
  existingBookings: any[],
  customSlots: any[],
) => {
  if (!operatingHours) {
    return [];
  }

  const slots: any[] = [];

  const openTime = parseTimeString(operatingHours.open);
  const effectiveOpenHour =
    openTime.minute > 0 ? openTime.hour + 1 : openTime.hour;

  const closeTime = parseTimeString(operatingHours.close);
  const closeHour = closeTime.hour;

  for (let hour = effectiveOpenHour; hour < closeHour; hour++) {
    const startTime = `${hour.toString().padStart(2, "0")}:00`;
    const endTime = `${(hour + 1).toString().padStart(2, "0")}:00`;

    const hasCustomOverlap = customSlots.some((cs) => {
      const csStart =
        parseInt(cs.startTime.split(":")[0]) * 60 +
        parseInt(cs.startTime.split(":")[1]);
      const csEnd =
        parseInt(cs.endTime.split(":")[0]) * 60 +
        parseInt(cs.endTime.split(":")[1]);
      const autoStart = hour * 60;
      const autoEnd = (hour + 1) * 60;
      return cs.date === date && csStart < autoEnd && csEnd > autoStart;
    });

    if (hasCustomOverlap) {
      continue;
    }

    const booking = existingBookings.find(
      (b) =>
        b.date === date &&
        b.startTime === startTime &&
        b.status !== "cancelled",
    );

    slots.push({
      id: `${date}-${startTime}`,
      date,
      startTime,
      endTime,
      available: !booking,
      price: 150,
      eventName: booking?.eventName || null,
      bookedBy: booking?.userId || null,
      bookedByUsername: booking?.userName || null,
      bookingId: booking?._id?.toString() || null,
      isCustom: false,
    });
  }

  return slots;
};

const checkSlotOverlap = async (
  venueId: string,
  spaceId: string,
  date: string,
  startTime: string,
  endTime: string,
  excludeSlotId?: string,
): Promise<boolean> => {
  const startMinutes =
    parseInt(startTime.split(":")[0]) * 60 + parseInt(startTime.split(":")[1]);
  const endMinutes =
    parseInt(endTime.split(":")[0]) * 60 + parseInt(endTime.split(":")[1]);

  const existingSlots = await TimeSlot.find({
    venueId,
    spaceId,
    date,
    isActive: true,
    ...(excludeSlotId ? { _id: { $ne: excludeSlotId } } : {}),
  });

  for (const slot of existingSlots) {
    const slotStart =
      parseInt(slot.startTime.split(":")[0]) * 60 +
      parseInt(slot.startTime.split(":")[1]);
    const slotEnd =
      parseInt(slot.endTime.split(":")[0]) * 60 +
      parseInt(slot.endTime.split(":")[1]);

    if (startMinutes < slotEnd && endMinutes > slotStart) {
      return true;
    }
  }

  return false;
};

router.get(
  "/venues/:venueId/spaces/:spaceId/timeslots",
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { date, startDate, endDate } = req.query;

      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      const dates: string[] = [];
      if (startDate && endDate) {
        const start = new Date(startDate as string);
        const end = new Date(endDate as string);
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          dates.push(d.toISOString().split("T")[0]);
        }
      } else if (date) {
        dates.push(date as string);
      } else {
        for (let i = 0; i < 14; i++) {
          const d = new Date();
          d.setDate(d.getDate() + i);
          dates.push(d.toISOString().split("T")[0]);
        }
      }

      const existingBookings = await Booking.find({
        venueId,
        spaceId,
        date: { $in: dates },
        status: { $ne: "cancelled" },
      });

      const customSlots = await TimeSlot.find({
        venueId,
        spaceId,
        date: { $in: dates },
        isActive: true,
      });

      const allSlots: any[] = [];
      const dayNames = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ];

      for (const dateStr of dates) {
        const dayOfWeek = new Date(dateStr).getDay();
        const dayName = dayNames[
          dayOfWeek
        ] as keyof typeof venue.operatingHours;
        const hours = venue.operatingHours?.[dayName] || null;

        const customSlotsForDate = customSlots.filter(
          (cs) => cs.date === dateStr,
        );

        const autoSlots = generateTimeSlots(
          dateStr,
          hours,
          existingBookings,
          customSlotsForDate,
        );
        allSlots.push(...autoSlots);

        for (const customSlot of customSlotsForDate) {
          const booking = existingBookings.find(
            (b) =>
              b.date === dateStr &&
              b.startTime === customSlot.startTime &&
              b.status !== "cancelled",
          );

          allSlots.push({
            id: customSlot._id.toString(),
            date: customSlot.date,
            startTime: customSlot.startTime,
            endTime: customSlot.endTime,
            available: !booking,
            price: customSlot.price,
            name: customSlot.name || null,
            description: customSlot.description || null,
            category: customSlot.category || null,
            ageRestriction: customSlot.ageRestriction || null,
            maxCapacity: customSlot.maxCapacity || null,
            eventName: booking?.eventName || null,
            bookedBy: booking?.userId || null,
            bookedByUsername: booking?.userName || null,
            bookingId: booking?._id?.toString() || null,
            isCustom: true,
          });
        }
      }

      allSlots.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.startTime.localeCompare(b.startTime);
      });

      res.status(200).json({
        venueId,
        spaceId,
        spaceName: space.name,
        slots: allSlots,
      });
    } catch (error) {
      console.error("Error fetching time slots:", error);
      res.status(500).json({ message: "Failed to fetch time slots" });
    }
  },
);

router.post(
  "/venues/:venueId/spaces/:spaceId/slots",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { date, startTime, endTime, price, name, description, category, ageRestriction, maxCapacity } = req.body;
      const user = (req as any).user;

      if (!date || !startTime || !endTime) {
        return res.status(400).json({
          message: "Missing required fields: date, startTime, endTime",
        });
      }

      const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        return res.status(400).json({
          message: "Invalid time format. Use HH:MM (24-hour format)",
        });
      }

      const startMinutes =
        parseInt(startTime.split(":")[0]) * 60 +
        parseInt(startTime.split(":")[1]);
      const endMinutes =
        parseInt(endTime.split(":")[0]) * 60 + parseInt(endTime.split(":")[1]);
      if (endMinutes <= startMinutes) {
        return res.status(400).json({
          message: "End time must be after start time",
        });
      }

      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      const hasOverlap = await checkSlotOverlap(
        venueId,
        spaceId,
        date,
        startTime,
        endTime,
      );
      if (hasOverlap) {
        return res.status(409).json({
          message: "This time slot overlaps with an existing slot",
        });
      }

      const timeSlot = await TimeSlot.create({
        venueId,
        spaceId,
        date,
        startTime,
        endTime,
        price: price || 150,
        name: name || undefined,
        description: description || undefined,
        category: category || undefined,
        ageRestriction: ageRestriction || undefined,
        maxCapacity: maxCapacity || undefined,
        isCustom: true,
        isActive: true,
        createdBy: user.id,
      });

      res.status(201).json({
        message: "Time slot created successfully",
        slot: {
          id: timeSlot._id.toString(),
          date: timeSlot.date,
          startTime: timeSlot.startTime,
          endTime: timeSlot.endTime,
          price: timeSlot.price,
          name: timeSlot.name || null,
          description: timeSlot.description || null,
          category: timeSlot.category || null,
          ageRestriction: timeSlot.ageRestriction || null,
          maxCapacity: timeSlot.maxCapacity || null,
          isCustom: true,
          available: true,
        },
      });
    } catch (error: any) {
      console.error("Error creating time slot:", error);
      if (error.code === 11000) {
        return res.status(409).json({
          message: "A slot with this time already exists",
        });
      }
      res.status(500).json({ message: "Failed to create time slot" });
    }
  },
);

router.put(
  "/venues/:venueId/spaces/:spaceId/slots/:slotId",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId, slotId } = req.params;
      const { date, startTime, endTime, price, name, description, category, ageRestriction, maxCapacity } = req.body;

      const existingSlot = await TimeSlot.findOne({
        _id: slotId,
        venueId,
        spaceId,
      });

      if (!existingSlot) {
        return res.status(404).json({ message: "Time slot not found" });
      }

      const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (startTime && !timeRegex.test(startTime)) {
        return res.status(400).json({
          message: "Invalid start time format. Use HH:MM (24-hour format)",
        });
      }
      if (endTime && !timeRegex.test(endTime)) {
        return res.status(400).json({
          message: "Invalid end time format. Use HH:MM (24-hour format)",
        });
      }

      const newStartTime = startTime || existingSlot.startTime;
      const newEndTime = endTime || existingSlot.endTime;
      const newDate = date || existingSlot.date;

      const startMinutes =
        parseInt(newStartTime.split(":")[0]) * 60 +
        parseInt(newStartTime.split(":")[1]);
      const endMinutes =
        parseInt(newEndTime.split(":")[0]) * 60 +
        parseInt(newEndTime.split(":")[1]);
      if (endMinutes <= startMinutes) {
        return res.status(400).json({
          message: "End time must be after start time",
        });
      }

      const hasOverlap = await checkSlotOverlap(
        venueId,
        spaceId,
        newDate,
        newStartTime,
        newEndTime,
        slotId,
      );
      if (hasOverlap) {
        return res.status(409).json({
          message: "This time slot overlaps with an existing slot",
        });
      }

      const booking = await Booking.findOne({
        venueId,
        spaceId,
        date: existingSlot.date,
        startTime: existingSlot.startTime,
        status: { $ne: "cancelled" },
      });

      if (
        booking &&
        (newStartTime !== existingSlot.startTime ||
          newEndTime !== existingSlot.endTime ||
          newDate !== existingSlot.date)
      ) {
        return res.status(409).json({
          message: "Cannot modify time for a slot that has an active booking",
        });
      }

      existingSlot.date = newDate;
      existingSlot.startTime = newStartTime;
      existingSlot.endTime = newEndTime;
      if (price !== undefined) existingSlot.price = price;
      if (name !== undefined) existingSlot.name = name || undefined;
      if (description !== undefined) existingSlot.description = description || undefined;
      if (category !== undefined) existingSlot.category = category || undefined;
      if (ageRestriction !== undefined) existingSlot.ageRestriction = ageRestriction || undefined;
      if (maxCapacity !== undefined) existingSlot.maxCapacity = maxCapacity || undefined;
      await existingSlot.save();

      res.status(200).json({
        message: "Time slot updated successfully",
        slot: {
          id: existingSlot._id.toString(),
          date: existingSlot.date,
          startTime: existingSlot.startTime,
          endTime: existingSlot.endTime,
          price: existingSlot.price,
          name: existingSlot.name || null,
          description: existingSlot.description || null,
          category: existingSlot.category || null,
          ageRestriction: existingSlot.ageRestriction || null,
          maxCapacity: existingSlot.maxCapacity || null,
          isCustom: true,
        },
      });
    } catch (error) {
      console.error("Error updating time slot:", error);
      res.status(500).json({ message: "Failed to update time slot" });
    }
  },
);

router.delete(
  "/venues/:venueId/spaces/:spaceId/slots/:slotId",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId, slotId } = req.params;

      const existingSlot = await TimeSlot.findOne({
        _id: slotId,
        venueId,
        spaceId,
      });

      if (!existingSlot) {
        return res.status(404).json({ message: "Time slot not found" });
      }

      const booking = await Booking.findOne({
        venueId,
        spaceId,
        date: existingSlot.date,
        startTime: existingSlot.startTime,
        status: { $ne: "cancelled" },
      });

      if (booking) {
        return res.status(409).json({
          message:
            "Cannot delete a slot that has an active booking. Cancel the booking first.",
        });
      }

      await TimeSlot.deleteOne({ _id: slotId });

      res.status(200).json({
        message: "Time slot deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting time slot:", error);
      res.status(500).json({ message: "Failed to delete time slot" });
    }
  },
);

router.post(
  "/venues/:venueId/spaces/:spaceId/generate-slots",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { startDate, endDate, price, name, description, category, ageRestriction, maxCapacity } = req.body;
      const user = (req as any).user;

      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      if (!venue.operatingHours) {
        return res.status(400).json({
          message: "Venue does not have operating hours configured",
        });
      }

      const start = startDate ? new Date(startDate) : new Date();
      const end = endDate
        ? new Date(endDate)
        : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

      const dayNames = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ] as const;

      const createdSlots: any[] = [];
      const skippedSlots: any[] = [];

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0];
        const dayOfWeek = d.getDay();
        const dayName = dayNames[dayOfWeek];
        const hours = venue.operatingHours[dayName];

        if (!hours) {
          continue;
        }

        const openTime = parseTimeString(hours.open);
        const effectiveOpenHour =
          openTime.minute > 0 ? openTime.hour + 1 : openTime.hour;
        const closeTime = parseTimeString(hours.close);
        const closeHour = closeTime.hour;

        for (let hour = effectiveOpenHour; hour < closeHour; hour++) {
          const startTime = `${hour.toString().padStart(2, "0")}:00`;
          const endTime = `${(hour + 1).toString().padStart(2, "0")}:00`;

          try {
            const timeSlot = await TimeSlot.create({
              venueId,
              spaceId,
              date: dateStr,
              startTime,
              endTime,
              price: price || 150,
              name: name || undefined,
              description: description || undefined,
              category: category || undefined,
              ageRestriction: ageRestriction || undefined,
              maxCapacity: maxCapacity || undefined,
              isCustom: false,
              isActive: true,
              createdBy: user.id,
            });

            createdSlots.push({
              id: timeSlot._id.toString(),
              date: dateStr,
              startTime,
              endTime,
              price: timeSlot.price,
            });
          } catch (error: any) {
            if (error.code === 11000) {
              skippedSlots.push({ date: dateStr, startTime, endTime });
            }
          }
        }
      }

      res.status(201).json({
        message: `Generated ${createdSlots.length} time slots`,
        created: createdSlots.length,
        skipped: skippedSlots.length,
        slots: createdSlots,
      });
    } catch (error) {
      console.error("Error generating time slots:", error);
      res.status(500).json({ message: "Failed to generate time slots" });
    }
  },
);

router.post(
  "/venues/:venueId/spaces/:spaceId/book",
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { date, startTime, endTime, eventName, notes } = req.body;
      const user = (req as any).user;

      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      if (!date || !startTime || !endTime || !eventName) {
        return res.status(400).json({
          message:
            "Missing required fields: date, startTime, endTime, eventName",
        });
      }

      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      const dbUser = await User.findById(user.id);
      if (!dbUser) {
        return res.status(401).json({ message: "User not found" });
      }

      const existingBooking = await Booking.findOne({
        venueId,
        spaceId,
        date,
        startTime,
        status: { $ne: "cancelled" },
      });

      if (existingBooking) {
        return res
          .status(409)
          .json({ message: "This time slot is already booked" });
      }

      const booking = await Booking.create({
        venueId,
        spaceId,
        spaceName: space.name,
        userId: user.id,
        userName: dbUser.name || dbUser.username,
        userEmail: dbUser.email,
        eventName,
        date,
        startTime,
        endTime,
        status: "pending",
        notes,
      });

      res.status(201).json({
        message: "Booking created successfully",
        booking,
      });
    } catch (error: any) {
      console.error("Error creating booking:", error);
      if (error.code === 11000) {
        return res
          .status(409)
          .json({ message: "This time slot is already booked" });
      }
      res.status(500).json({ message: "Failed to create booking" });
    }
  },
);

router.post(
  "/venues/:venueId/spaces/:spaceId/inquire",
  async (req: Request, res: Response) => {
    try {
      const { venueId, spaceId } = req.params;
      const { message, preferredDate, preferredTime, phone } = req.body;
      const user = (req as any).user;

      if (!user || !user.id) {
        return res.status(401).json({ message: "Authentication required" });
      }

      if (!message) {
        return res.status(400).json({ message: "Message is required" });
      }

      const venue = await Venue.findById(venueId);
      if (!venue) {
        return res.status(404).json({ message: "Venue not found" });
      }

      const space = venue.subVenues.find((s) => s.id === spaceId);
      if (!space) {
        return res.status(404).json({ message: "Space not found" });
      }

      const dbUser = await User.findById(user.id);
      if (!dbUser) {
        return res.status(401).json({ message: "User not found" });
      }

      const inquiry = await Inquiry.create({
        venueId,
        spaceId,
        spaceName: space.name,
        userId: user.id,
        userName: dbUser.name || dbUser.username,
        userEmail: dbUser.email,
        userPhone: phone,
        preferredDate,
        preferredTime,
        message,
        status: "new",
      });

      res.status(201).json({
        message: "Inquiry sent successfully",
        inquiry,
      });
    } catch (error) {
      console.error("Error creating inquiry:", error);
      res.status(500).json({ message: "Failed to send inquiry" });
    }
  },
);

router.get("/bookings/my", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const bookings = await Booking.find({ userId: user.id })
      .populate("venueId", "name address")
      .sort({ date: -1, startTime: -1 });

    res.status(200).json(bookings);
  } catch (error) {
    console.error("Error fetching bookings:", error);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
});

router.patch("/bookings/:id/cancel", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    if (!user || !user.id) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.userId.toString() !== user.id) {
      const dbUser = await User.findById(user.id);
      if (!dbUser?.isAdmin) {
        return res
          .status(403)
          .json({ message: "Not authorized to cancel this booking" });
      }
    }

    await Booking.findByIdAndDelete(req.params.id);

    res.status(200).json({ message: "Booking cancelled and removed" });
  } catch (error) {
    console.error("Error cancelling booking:", error);
    res.status(500).json({ message: "Failed to cancel booking" });
  }
});

router.get(
  "/venues/:venueId/bookings",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { venueId } = req.params;
      const { date, status } = req.query;

      const filter: any = { venueId };
      if (date) filter.date = date;
      if (status) filter.status = status;

      const bookings = await Booking.find(filter).sort({
        date: 1,
        startTime: 1,
      });

      res.status(200).json(bookings);
    } catch (error) {
      console.error("Error fetching venue bookings:", error);
      res.status(500).json({ message: "Failed to fetch bookings" });
    }
  },
);

router.patch(
  "/bookings/:id/status",
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { status } = req.body;
      if (!status || !["pending", "confirmed", "cancelled"].includes(status)) {
        return res.status(400).json({ message: "Invalid status" });
      }

      const booking = await Booking.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true },
      );

      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }

      res.status(200).json(booking);
    } catch (error) {
      console.error("Error updating booking status:", error);
      res.status(500).json({ message: "Failed to update booking" });
    }
  },
);

export default router;
