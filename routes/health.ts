import { Router, Request, Response } from "express";

const router = Router();

router.get("/check", (req: Request, res: Response) => {
  res.sendStatus(200);
});

router.get("/", (req: Request, res: Response) => {
  res.send("Welcome to a better way to play!");
});

export default router;
