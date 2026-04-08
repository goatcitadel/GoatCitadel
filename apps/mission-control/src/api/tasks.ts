/** Tasks domain slice. Pure re-exports from client.ts. */
export {
  fetchTasks,
  fetchTasksByView,
  createTask,
  updateTask,
  deleteTask,
  restoreTask,
  fetchTaskActivities,
  addTaskActivity,
  fetchTaskDeliverables,
  addTaskDeliverable,
  fetchTaskSubagents,
  registerTaskSubagent,
  updateTaskSubagent,
} from "./client.js";
