import express from "express";
import { createId, formatTimestamp, clampValue } from "./utils.js";

const app = express();
app.use(express.json());

interface Task {
  id: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "done";
  createdAt: string;
}

const tasks: Map<string, Task> = new Map();

app.get("/api/tasks", (_req, res) => {
  const all = Array.from(tasks.values());
  res.json({ data: all, total: all.length });
});

app.get("/api/tasks/:id", (req, res) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json({ data: task });
});

app.post("/api/tasks", (req, res) => {
  const { title, description } = req.body;
  if (!title || typeof title !== "string") {
    res.status(400).json({ error: "Title is required" });
    return;
  }
  const task: Task = {
    id: createId(),
    title,
    description: description ?? "",
    status: "pending",
    createdAt: formatTimestamp(new Date()),
  };
  tasks.set(task.id, task);
  res.status(201).json({ data: task });
});

app.put("/api/tasks/:id", (req, res) => {
  const existing = tasks.get(req.params.id);
  if (!existing) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const updated: Task = {
    ...existing,
    title: req.body.title ?? existing.title,
    description: req.body.description ?? existing.description,
    status: req.body.status ?? existing.status,
  };
  tasks.set(updated.id, updated);
  res.json({ data: updated });
});

app.delete("/api/tasks/:id", (req, res) => {
  if (!tasks.delete(req.params.id)) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.status(204).end();
});

const PORT = clampValue(Number(process.env.PORT) || 3000, 1024, 65535);
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
