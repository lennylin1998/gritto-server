⸻

/v1/auth/google

Purpose

Authenticate a user via Google Sign-In token, validate it using the server’s GOOGLE_CLIENT_ID env var, create a profile on first login, and issue a JWT session token using JWT_SECRET.

⸻

1️⃣ Endpoint

POST /v1/auth/google

⸻

2️⃣ Expected Request

{
  "idToken": "<Google ID token from client>"
}

Headers

None (unauthenticated endpoint)

Validation
	•	idToken must be a valid Google-issued token verified against GOOGLE_CLIENT_ID.
	•	Reject expired or malformed tokens.

⸻

3️⃣ Processing Logic

Step	Description	Related Model / Function
1️⃣	Verify Google ID token signature and audience (GOOGLE_CLIENT_ID) via Google OAuth2 client.	External (Google API)
2️⃣	Extract Google user info (email, name, picture, sub) from verified payload.	Google Payload
3️⃣	Query Firestore User collection for matching email.	UserModel.findByEmail()
4️⃣	If user does not exist → Create new record with default values (availableHoursPerWeek = 20, timezone = UTC).	UserModel.create()
5️⃣	Generate signed JWT using JWT_SECRET containing: { userId, email, exp }.	AuthService.generateToken()
6️⃣	Return token and user profile data.	Response object


⸻

4️⃣ Edge Cases

Case	Behavior	Response
Invalid / expired Google token	Reject request	401 Unauthorized
Missing required field (idToken)	Reject request	400 Bad Request
Token email not verified (email_verified = false)	Reject request	403 Forbidden
First login success	Auto-create user profile	201 Created
Returning user	Fetch existing record	200 OK


⸻

5️⃣ Response Examples

✅ 200 OK (Existing User)

{
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI...",
    "user": {
      "id": "u_001",
      "name": "Lenny Zhang",
      "email": "lenny@example.com",
      "profileImageUrl": "https://lh3.googleusercontent.com/a/abcd1234",
      "timezone": "America/Chicago",
      "availableHoursPerWeek": 25,
      "createdAt": "2025-10-20T18:00:00Z",
      "updatedAt": "2025-10-25T12:00:00Z"
    }
  }
}

🆕 201 Created (First Login)

{
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI...",
    "user": {
      "id": "u_new_123",
      "name": "New User",
      "email": "newuser@gmail.com",
      "profileImageUrl": "https://lh3.googleusercontent.com/a/newphoto",
      "timezone": "UTC",
      "availableHoursPerWeek": 20,
      "createdAt": "2025-11-03T10:00:00Z",
      "updatedAt": "2025-11-03T10:00:00Z"
    }
  }
}

❌ 401 Unauthorized

{
  "error": {
    "code": 401,
    "message": "Invalid or expired Google ID token."
  }
}

❌ 403 Forbidden

{
  "error": {
    "code": 403,
    "message": "Google account email not verified."
  }
}


⸻

6️⃣ Function Description

Main Function

AuthController.googleLogin(req, res)

Handles Google authentication, profile creation, and JWT issuance.

Involved Models
	•	UserModel (Firestore collection: User)
	•	Fields: id, email, name, profileImageUrl, timezone, availableHoursPerWeek, createdAt, updatedAt
	•	SessionToken (JWT) – Not persisted, generated dynamically per request.

Side Effects
	•	Creates a new user entry on first login.
	•	Updates updatedAt timestamp each login.
	•	Returns signed JWT for subsequent authenticated API calls.

⸻

/v1/me

Purpose

Manage authenticated user profile — fetching or updating profile data associated with the active JWT session.

⸻

1️⃣ Endpoints

Method	Path	Purpose
GET	/v1/me	Fetch current user profile
PATCH	/v1/me	Update user profile fields


⸻

2️⃣ GET /v1/me

Request
	•	Authentication:
Requires Bearer Token (JWT) in header:

Authorization: Bearer <token>


	•	Input:
None in body or query.

⸻

Processing Logic

Step	Description	Related Model / Function
1️⃣	Decode and verify JWT token using JWT_SECRET.	authMiddleware
2️⃣	Extract userId from token payload.	Token payload
3️⃣	Query Firestore User collection for userId.	UserModel.findById()
4️⃣	Return full profile if found.	—


⸻

Edge Cases

Case	Behavior	Response
Missing / invalid JWT	Reject request	401 Unauthorized
User not found	Return error	404 Not Found


⸻

Response Examples

✅ 200 OK

{
  "data": {
    "id": "u_001",
    "name": "Lenny",
    "email": "lenny@example.com",
    "profileImageUrl": "https://cdn.app/avatar/lenny.png",
    "timezone": "America/Chicago",
    "availableHoursPerWeek": 30,
    "createdAt": "2025-10-20T18:00:00Z",
    "updatedAt": "2025-10-25T12:00:00Z"
  }
}

❌ 401 Unauthorized

{
  "error": {
    "code": 401,
    "message": "Invalid or expired session token."
  }
}

❌ 404 Not Found

{
  "error": {
    "code": 404,
    "message": "User not found."
  }
}


⸻

3️⃣ PATCH /v1/me

Request

Authentication:

Authorization: Bearer <token>

Request Body:

{
  "name": "Lenny Zhang",
  "timezone": "America/New_York",
  "availableHoursPerWeek": 25,
  "profileImageUrl": "https://cdn.app/avatar/new.png"
}


⸻

Processing Logic

Step	Description	Related Model / Function
1️⃣	Verify JWT token and extract userId.	authMiddleware
2️⃣	Fetch existing User document.	UserModel.findById()
3️⃣	Merge allowed fields from body: name, timezone, availableHoursPerWeek, profileImageUrl.	—
4️⃣	If availableHoursPerWeek is provided → calculate total hours from all active goals.	GoalModel.sumActiveGoalHours(userId)
5️⃣	If total goal hours > availableHoursPerWeek, reject update with 409 Conflict.	—
6️⃣	Otherwise, update User record and set updatedAt timestamp.	UserModel.updateById()
7️⃣	Return updated record.	—


⸻

Validation
	•	Reject empty body.
	•	Reject changes to immutable fields (email, id, createdAt).
	•	Validate availableHoursPerWeek as positive integer (0–168).
	•	Check if user’s available hours can support all active goals:
	•	availableHoursPerWeek >= sum(goal.hoursPerWeek for status='active')

⸻

Edge Cases

Case	Behavior	Response
Invalid JWT	Reject request	401 Unauthorized
Invalid data format	Reject request	400 Bad Request
User not found	Reject request	404 Not Found
Insufficient available hours	Reject update	409 Conflict


⸻

Response Examples

✅ 200 OK

{
  "data": {
    "id": "u_001",
    "name": "Lenny Zhang",
    "email": "lenny@example.com",
    "profileImageUrl": "https://cdn.app/avatar/new.png",
    "timezone": "America/New_York",
    "availableHoursPerWeek": 25,
    "createdAt": "2025-10-20T18:00:00Z",
    "updatedAt": "2025-11-03T15:00:00Z"
  }
}

❌ 400 Bad Request

{
  "error": {
    "code": 400,
    "message": "Invalid timezone format or missing required field."
  }
}

❌ 409 Conflict — Insufficient Available Hours

{
  "error": {
    "code": 409,
    "message": "Available hours (25h/week) are insufficient for current active goals (32h/week required).",
    "details": {
      "availableHoursPerWeek": 25,
      "requiredHoursPerWeek": 32,
      "conflictingGoals": [
        { "goalId": "g_123", "title": "Build Portfolio Website", "weeklyHours": 18 },
        { "goalId": "g_456", "title": "Study for GRE", "weeklyHours": 14 }
      ]
    }
  }
}


⸻

4️⃣ Function Descriptions

GET

UserController.getProfile(req, res)
	•	Decodes JWT → fetches user profile → returns record.

PATCH

UserController.updateProfile(req, res)
	•	Authenticates → validates payload → checks total goal hours → updates user → returns updated record.

⸻

5️⃣ Involved Models

Model	Description
UserModel	Firestore collection: User
GoalModel	Firestore collection: Goal used to compute weekly time requirement

Goal aggregation logic:

totalGoalHours = sum(goal.hoursPerWeek for goal in active_goals)
if newAvailableHours < totalGoalHours:
    throw ConflictError(409)


⸻

6️⃣ Side Effects
	•	Updates Firestore user record.
	•	Validates business rule consistency with active goals.
	•	Logs update attempt (optional future enhancement).

⸻

Excellent refinement — here’s the fully expanded Goal Domain API documentation, now including function description, involved models, and side effects per endpoint, while keeping your authentication middleware structure intact.

⸻

🎯 Goal Domain API (with Auth Middleware)

Handles all CRUD and metric operations for user goals.
Each goal is owned by a user (User.userId) and interacts with Milestones and Tasks for progress tracking.

⸻

🧩 Shared Middleware

All routes in this domain are protected by a shared middleware:

router.use('/v1/goals', authMiddleware);

export const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { userId: decoded.userId, email: decoded.email };
    next();
  } catch {
    res.status(401).json({ error: { code: 401, message: 'Unauthorized' } });
  }
};


⸻

1️⃣ POST /v1/goals

Purpose

Create a new goal for the authenticated user.

⸻

Function Description

GoalController.createGoal(req, res)
	•	Extracts userId from req.user.
	•	Validates input fields (title, hoursPerWeek, priority).
	•	Fetches user’s available weekly hours.
	•	Calculates total hoursPerWeek from all active goals + the new goal.
	•	Rejects if total exceeds user capacity.
	•	Creates goal in Firestore and returns the record.

⸻

Involved Models

Model	Used For
UserModel	Fetch user’s available hours (availableHoursPerWeek).
GoalModel	Insert new goal document; calculate total active hours.


⸻

Side Effects
	•	Writes new Goal document in Firestore.
	•	Updates createdAt and updatedAt timestamps.
	•	May trigger downstream recalculations in analytics (optional future hook).

⸻

2️⃣ GET /v1/goals?status=active

Purpose

List all goals for the user, optionally filtered by status.

⸻

Function Description

GoalController.listGoals(req, res)
	•	Reads status from query params (active / completed / all).
	•	Retrieves user’s goals from Firestore.
	•	Computes for each goal:
	•	totalTaskHours
	•	doneTaskHours
	•	Returns a summary list sorted by priority.

⸻

Involved Models

Model	Used For
GoalModel	Query user’s goals filtered by status.
TaskModel	Aggregate task durations for each goal.
MilestoneModel	Used to traverse to related tasks.
UserModel	Used to compare available hours when listing active goals (409 Conflict check).


⸻

Side Effects
	•	None (read-only query).
	•	May trigger cache read for metrics aggregation in GoalMetricsService.

⸻

3️⃣ GET /v1/goals/{goalId}

Purpose

Retrieve full metadata for a single goal.

⸻

Function Description

GoalController.getGoal(req, res)
	•	Extracts { goalId } from path.
	•	Fetches the goal document.
	•	Ensures goal.userId === req.user.userId.
	•	Returns goal details (excluding nested milestones or tasks).

⸻

Involved Models

Model	Used For
GoalModel	Find a specific goal by ID.


⸻

Side Effects
	•	None (pure data fetch).
	•	May increment access count or log read operation (optional).

⸻

4️⃣ PATCH /v1/goals/{goalId}

Purpose

Update existing goal metadata (e.g., title, color, hoursPerWeek, status).

⸻

Function Description

GoalController.updateGoal(req, res)
	•	Fetches target goal by ID and ensures ownership.
	•	Validates updatable fields:
	•	title, status, color, hoursPerWeek, priority.
	•	If status changes to "active" or hours increase:
	•	Compute total hoursPerWeek across all active goals.
	•	Compare against user’s availableHoursPerWeek.
	•	Reject with 409 Conflict if total exceeds capacity.
	•	Apply update and refresh updatedAt.

⸻

Involved Models

Model	Used For
GoalModel	Fetch and update goal; compute active goal hours.
UserModel	Fetch availableHoursPerWeek to compare limits.


⸻

Side Effects
	•	Updates Firestore Goal record.
	•	Changes goal’s active/inactive status, impacting downstream milestones and scheduling.
	•	Updates updatedAt field.
	•	May invalidate cached progress metrics for the goal.

⸻

5️⃣ GET /v1/goals/{goalId}/metrics

Purpose

Show progress metrics of a goal: total vs completed task hours.

⸻

Function Description

GoalController.getGoalMetrics(req, res)
	•	Uses goalId from path params.
	•	Aggregates all tasks linked to the goal via milestones.
	•	Computes:
	•	totalTaskHours = sum(task.estimatedHours)
	•	doneTaskHours = sum(task.estimatedHours where done == true)
	•	Returns progress snapshot.

⸻

Involved Models

Model	Used For
MilestoneModel	To find milestones under this goal.
TaskModel	To aggregate all task durations and statuses.
GoalModel	For goal-level reference.


⸻

Side Effects
	•	Read-only; no writes.
	•	May trigger an update in GoalMetricsCache (optional future improvement).

⸻

🧠 Summary Table

Endpoint	Controller Function	Models Used	Side Effects
POST /v1/goals	createGoal	UserModel, GoalModel	Writes new goal; updates timestamps.
GET /v1/goals?status=active	listGoals	GoalModel, TaskModel, MilestoneModel, UserModel	Read-only; aggregates metrics.
GET /v1/goals/{goalId}	getGoal	GoalModel	None.
PATCH /v1/goals/{goalId}	updateGoal	GoalModel, UserModel	Writes update; may alter active status and invalidate metrics.
GET /v1/goals/{goalId}/metrics	getGoalMetrics	GoalModel, MilestoneModel, TaskModel	Read-only; computes live progress.

⸻

🧩 Cross-Domain Interactions
	•	When activating or creating new goals:
	•	Requires User.availableHoursPerWeek >= sum(activeGoals.hoursPerWeek).

⸻

This section covers both milestone subroutes (/v1/goals/{goalId}/milestones) and direct milestone endpoints (/v1/milestones/{id}), including detailed function descriptions, involved models, and side effects per endpoint.

⸻

🪜 Milestone Domain API (with Auth Middleware)

Milestones represent the intermediate steps toward achieving a goal.
Each Milestone belongs to a single Goal and can contain nested sub-milestones or tasks.

⸻

🧩 Shared Middleware

All routes in this domain require authentication:

router.use(['/v1/goals/:goalId/milestones', '/v1/milestones'], authMiddleware);

authMiddleware attaches the authenticated user object to req.user:

req.user = { userId, email };


⸻

1️⃣ GET /v1/goals/{goalId}/milestones

Purpose

List all milestones under a given goal.
This endpoint powers the Goal Page UI tree and provides each milestone’s basic info.

⸻

Function Description

MilestoneController.listMilestonesByGoal(req, res)
	•	Reads goalId from path parameters.
	•	Ensures the goal belongs to the authenticated user.
	•	Queries Firestore for all milestones with goalId = req.params.goalId.
	•	Returns lightweight milestone objects (id, title, status).

⸻

Involved Models

Model	Used For
GoalModel	Validate goal ownership (goal.userId === req.user.userId).
MilestoneModel	Fetch milestone documents for the goal.


⸻

Side Effects
	•	None (read-only operation).
	•	May trigger metrics caching refresh if milestone progress summaries are attached later.

⸻

Response Example

✅ 200 OK

{
  "data": [
    { "id": "m_789", "title": "Finish Kotlin Basics", "status": "in_progress" },
    { "id": "m_790", "title": "Build a mobile app", "status": "not_started" }
  ]
}


⸻

2️⃣ POST /v1/goals/{goalId}/milestones

Purpose

Create a new milestone under a goal.

⸻

Function Description

MilestoneController.createMilestone(req, res)
	•	Extracts goalId and authenticated userId.
	•	Validates milestone fields (title, optional description, optional parentMilestoneId).
	•	Ensures goal ownership.
	•	Creates new milestone document with default status "blocked".
	•	Sets createdAt and updatedAt timestamps.

⸻

Involved Models

Model	Used For
GoalModel	Ownership validation.
MilestoneModel	Insert milestone document under the goal.


⸻

Side Effects
	•	Writes new milestone document in Firestore.
	•	May trigger updates to goal progress or order in the UI tree.

⸻

Response Example

✅ 201 Created

{
  "data": {
    "id": "m_789",
    "title": "Build core UI",
    "description": "Implement Home, Goals, and Task pages",
    "status": "blocked",
    "createdAt": "2025-10-25T18:30:00Z"
  }
}


⸻

3️⃣ GET /v1/milestones/{milestoneId}

Purpose

Retrieve metadata of a single milestone.

⸻

Function Description

MilestoneController.getMilestone(req, res)
	•	Reads milestoneId from path.
	•	Fetches the milestone and associated goal.
	•	Ensures the goal belongs to the authenticated user.
	•	Returns milestone details (title, description, status).

⸻

Involved Models

Model	Used For
MilestoneModel	Fetch milestone document.
GoalModel	Verify user ownership via goal relation.


⸻

Side Effects
	•	None (read-only).
	•	Optionally updates a lastViewedAt field for analytics (future enhancement).

⸻

Response Example

✅ 200 OK

{
  "data": {
    "id": "m_789",
    "title": "Learn Kotlin Multiplatform",
    "description": "Implement Home, Goals, and Task pages",
    "status": "in_progress"
  }
}


⸻

4️⃣ PATCH /v1/milestones/{milestoneId}

Purpose

Update milestone metadata such as title, description, or status.

⸻

Function Description

MilestoneController.updateMilestone(req, res)
	•	Extracts milestoneId from path and userId from middleware.
	•	Validates input fields:
	•	Allowed: title, description, status.
	•	Fetches milestone and related goal to ensure ownership.
	•	Updates milestone record in Firestore and refreshes updatedAt.

⸻

Involved Models

Model	Used For
MilestoneModel	Update milestone record.
GoalModel	Ownership validation.


⸻

Side Effects
	•	Updates Milestone.status.
	•	If milestone status changes to "finished", optional propagation:
	•	Marks child tasks as "done" (if any).
	•	Updates parent goal’s completion metrics.
	•	Updates updatedAt timestamp.

⸻

Response Example

✅ 200 OK

{
  "data": {
    "id": "m_789",
    "goalId": "g_123",
    "status": "in_progress",
    "updatedAt": "2025-10-25T20:00:00Z"
  }
}


⸻

5️⃣ GET /v1/milestones/{milestoneId}/metrics

Purpose

Retrieve milestone-level progress (based on tasks linked to the milestone).

⸻

Function Description

MilestoneController.getMilestoneMetrics(req, res)
	•	Extracts milestoneId.
	•	Validates ownership via parent goal.
	•	Aggregates total and completed task hours for all tasks in this milestone.
	•	Returns progress summary.

⸻

Involved Models

Model	Used For
MilestoneModel	Base milestone reference.
TaskModel	Fetch all tasks belonging to this milestone.
GoalModel	Ownership verification (goal.userId).


⸻

Side Effects
	•	Read-only operation.
	•	May update or warm a metrics cache layer (MilestoneMetricsCache).

⸻

Response Example

✅ 200 OK

{
  "data": {
    "milestoneId": "m_789",
    "totalTaskHours": 10,
    "doneTaskHours": 6
  }
}


⸻

🧠 Summary Table

Endpoint	Controller Function	Models Used	Side Effects
GET /v1/goals/{goalId}/milestones	listMilestonesByGoal	GoalModel, MilestoneModel	Read-only.
POST /v1/goals/{goalId}/milestones	createMilestone	GoalModel, MilestoneModel	Inserts milestone; links to goal.
GET /v1/milestones/{milestoneId}	getMilestone	MilestoneModel, GoalModel	Read-only.
PATCH /v1/milestones/{milestoneId}	updateMilestone	MilestoneModel, GoalModel	Updates status, description, timestamps.
GET /v1/milestones/{milestoneId}/metrics	getMilestoneMetrics	MilestoneModel, TaskModel, GoalModel	Read-only; aggregates task hours.


⸻

🔐 Auth Middleware Integration
	•	All milestone endpoints require req.user populated by the shared authMiddleware.
	•	Middleware prevents unauthorized access before any Firestore query.

⸻

🔄 Cross-Domain Interaction
	•	Milestones live under Goals:
	•	Goal.status or completion triggers can cascade down to milestones.
	•	Task-level updates can bubble up to milestone progress recalculation.
	•	Metrics are typically aggregated at:
	•	Milestone → Goal → Dashboard.

⸻

🧩 Data Relationship Recap

User (1)
 └── Goal (many)
      └── Milestone (many)
           └── Task (many)

Each controller enforces this hierarchy to guarantee:
	•	Proper data isolation per user.
	•	Predictable roll-up aggregation for analytics.

⸻
here’s the complete Task Domain API, covering task creation, retrieval, update, and completion toggling.

⸻

✅ Task Domain API (with Auth Middleware)

Tasks represent the smallest actionable unit under a milestone.
They carry time-bound scheduling information and are used to measure goal progress.

⸻

🧩 Shared Middleware

All task endpoints require authentication and are protected by:

router.use(['/v1/milestones/:milestoneId/tasks', '/v1/tasks'], authMiddleware);

Middleware attaches authenticated user info to each request:

req.user = { userId, email };


⸻

1️⃣ POST /v1/milestones/{milestoneId}/tasks

Purpose

Create a new task under a specific milestone.

⸻

Function Description

TaskController.createTask(req, res)
	•	Extracts milestoneId and authenticated userId.
	•	Validates required fields:
	•	title, date, estimatedHours
	•	Ensures the milestone belongs to a goal owned by the user.
	•	Checks for date conflicts:
	•	Cannot overlap with another task of the same milestone or user’s existing calendar events.
	•	Inserts task document with done = false by default.
	•	Sets timestamps.

⸻

Involved Models

Model	Used For
GoalModel	Validate ownership via parent goal.
MilestoneModel	Validate milestone existence.
TaskModel	Create new task record; perform conflict check.


⸻

Side Effects
	•	Writes new task document in Firestore.
	•	Updates Milestone.tasks[] reference list.
	•	May increment milestone’s totalTaskHours.
	•	Potentially triggers resync for home dashboard.

⸻

Response Examples

✅ 201 Created

{
  "data": {
    "id": "t_789",
    "milestoneId": "m_456",
    "title": "Implement Home Screen",
    "date": "2025-11-02",
    "estimatedHours": 4,
    "status": "not_yet_done",
    "createdAt": "2025-10-25T18:40:00Z"
  }
}

❌ 409 Conflict — Task Date Overlap

{
  "error": {
    "code": 409,
    "message": "Task date conflicts with an existing scheduled task or calendar event.",
    "details": {
      "conflictingTaskId": ["t_654", "t_655"]
    }
  }
}


⸻

2️⃣ GET /v1/tasks/{taskId}

Purpose

Retrieve metadata for a specific task.

⸻

Function Description

TaskController.getTask(req, res)
	•	Reads taskId from path.
	•	Fetches task document from Firestore.
	•	Validates ownership through linked milestone → goal → user.
	•	Returns all editable fields.

⸻

Involved Models

Model	Used For
TaskModel	Fetch task details.
MilestoneModel	Locate parent milestone.
GoalModel	Verify ownership by current user.


⸻

Side Effects
	•	None (read-only).
	•	May update lastViewedAt timestamp (optional enhancement).

⸻

Response Example

✅ 200 OK

{
  "data": {
    "id": "t_789",
    "milestoneId": "m_456",
    "title": "Implement Home Screen",
    "description": "Task list and goal progress UI",
    "date": "2025-11-02",
    "estimatedHours": 4,
    "done": false,
    "createdAt": "2025-10-25T18:40:00Z",
    "updatedAt": "2025-10-25T18:40:00Z"
  }
}


⸻

3️⃣ PATCH /v1/tasks/{taskId}

Purpose

Update task metadata (e.g. mark as done, change date or title).

⸻

Function Description

TaskController.updateTask(req, res)
	•	Extracts taskId and authenticated userId.
	•	Validates editable fields:
	•	title, description, date, estimatedHours, done
	•	Verifies task ownership.
	•	If changing date, performs conflict check:
	•	Ensures new date doesn’t overlap with another task under the same milestone.
	•	Updates document and refreshes updatedAt.

⸻

Involved Models

Model	Used For
TaskModel	Fetch and update task record; conflict detection.
MilestoneModel	Ownership validation (via goal).
GoalModel	Deep ownership validation and progress tracking.


⸻

Side Effects
	•	Updates Firestore task record.
	•	Recalculates milestone progress if done or estimatedHours changed.
	•	Triggers downstream updates for:
	•	/v1/goals/{goalId}/metrics
	•	/v1/milestones/{milestoneId}/metrics
	•	Updates updatedAt.

⸻

Response Examples

✅ 200 OK

{
  "data": {
    "id": "t_789",
    "status": "done",
    "date": "2025-11-03",
    "updatedAt": "2025-10-25T20:00:00Z"
  }
}

❌ 409 Conflict — Task Date Conflict

{
  "error": {
    "code": 409,
    "message": "Cannot update task. The new date conflicts with another task under the same milestone.",
    "details": {
      "conflictingTaskId": ["t_710", "t_711"]
    }
  }
}


⸻

4️⃣ POST /v1/tasks/{taskId}:done

Purpose

Mark a task as completed.

⸻

Function Description

TaskController.markTaskDone(req, res)
	•	Reads taskId and authenticated user.
	•	Confirms task ownership.
	•	Updates done = true, sets updatedAt or doneAt.
	•	Recomputes milestone and goal progress.

⸻

Involved Models

Model	Used For
TaskModel	Update task status.
MilestoneModel	Aggregate new completion ratio.
GoalModel	Reflect milestone updates at goal level.


⸻

Side Effects
	•	Updates Firestore record.
	•	Adjusts doneTaskHours in milestone metrics.
	•	May trigger GoalMetricsService background refresh.
	•	Sets completion timestamp.

⸻

Response Example

✅ 200 OK

{
  "data": {
    "id": "t_789",
    "status": "done",
    "updatedAt": "2025-10-25T22:00:00Z"
  }
}


⸻

5️⃣ POST /v1/tasks/{taskId}:undone

Purpose

Undo a previously completed task (reopen it).

⸻

Function Description

TaskController.markTaskUndone(req, res)
	•	Reads taskId.
	•	Confirms ownership.
	•	Updates done = false and refreshes updatedAt.
	•	Decrements milestone and goal progress counters accordingly.

⸻

Involved Models

Model	Used For
TaskModel	Update done status.
MilestoneModel	Update progress aggregation.
GoalModel	Cascade progress adjustments.


⸻

Side Effects
	•	Reverts task status in Firestore.
	•	Recalculates milestone and goal metrics.
	•	May notify UI via WebSocket or analytics hooks (optional).

⸻

Response Example

✅ 200 OK

{
  "data": {
    "id": "t_789",
    "status": "not_yet_done",
    "updatedAt": "2025-10-25T22:10:00Z"
  }
}


⸻

🧠 Summary Table

Endpoint	Controller Function	Models Used	Side Effects
POST /v1/milestones/{milestoneId}/tasks	createTask	GoalModel, MilestoneModel, TaskModel	Creates task; updates milestone task list; conflict check.
GET /v1/tasks/{taskId}	getTask	TaskModel, MilestoneModel, GoalModel	Read-only.
PATCH /v1/tasks/{taskId}	updateTask	TaskModel, MilestoneModel, GoalModel	Updates task metadata; may alter progress; conflict check.
POST /v1/tasks/{taskId}:done	markTaskDone	TaskModel, MilestoneModel, GoalModel	Sets done=true; updates progress counters.
POST /v1/tasks/{taskId}:undone	markTaskUndone	TaskModel, MilestoneModel, GoalModel	Sets done=false; decrements metrics.


⸻

🔐 Auth Middleware Integration
	•	Middleware authenticates once per request.
	•	req.user.userId is used for all ownership validation.
	•	Returns 401 Unauthorized if missing/invalid token before controller execution.

⸻

🔄 Cross-Domain Interactions
	•	Each task is nested under a Milestone, which belongs to a Goal.
	•	Task operations update higher-level progress:
	•	Task → Milestone → Goal.
	•	When a task changes state (done/undone):
	•	Aggregated metrics update goal’s completion percentage.
	•	Dashboard and reflection agent may consume this data.

⸻

🧩 Data Relationship Recap

User (1)
 └── Goal (many)
      └── Milestone (many)
           └── Task (many)

Ownership and data propagation are strictly enforced in this hierarchy.

⸻

🏠 Home Dashboard Domain API (with Auth Middleware)

The Home Dashboard domain provides task summaries by day and active goal overviews for the current authenticated user.

⸻

🧩 Shared Middleware

All routes here are protected by:

router.use(['/v1/tasks:query', '/v1/goals'], authMiddleware);


⸻

1️⃣ GET /v1/tasks:query?day=YYYY-MM-DD

Purpose

Fetch all tasks scheduled for a specific day across all milestones for the authenticated user.

This endpoint powers the Task List section on the Home screen (grouped by date).

⸻

Function Description

DashboardController.queryTasksByDay(req, res)
	•	Extracts day (ISO date string) from query parameters.
	•	Converts to UTC date range (start-of-day to end-of-day).
	•	Fetches all tasks whose date falls within that range, and status is not yet done.
	•	Ensures ownership through milestone → goal → user relation.
	•	Returns each task with its metadata and status.

⸻

Involved Models

Model	Used For
TaskModel	Query tasks by date range.
MilestoneModel	Fetch milestone relationships.
GoalModel	Validate task ownership (goal.userId === req.user.userId).


⸻

Side Effects
	•	None (read-only operation).
	•	May update daily cache for the user’s dashboard (optional future optimization).

⸻

Response Example

✅ 200 OK

{
  "data": [
    {
      "id": "t_001",
      "milestoneId": "m_456",
      "title": "UI Layout",
      "description": "Implement main layout",
      "date": "2025-11-01",
      "estimatedHours": 3,
      "status": "not_yet_done",
      "createdAt": "2025-10-25T12:00:00Z",
      "updatedAt": "2025-10-25T12:00:00Z"
    },
    {
      "id": "t_002",
      "milestoneId": "m_456",
      "title": "Color Palette",
      "date": "2025-11-01",
      "estimatedHours": 2,
      "status": "not_yet_done",
      "createdAt": "2025-10-22T10:00:00Z",
      "updatedAt": "2025-10-25T09:00:00Z"
    }
  ]
}


⸻

Edge Cases

Case	Behavior	Response
Missing day param	Reject request	400 Bad Request
Invalid date format	Reject request	400 Bad Request
No tasks found	Return empty array	200 OK


⸻

2️⃣ GET /v1/goals?status=active

Purpose

List all active goals with summarized progress for the user.
This endpoint powers the Goal List section of the Home screen.

⸻

Function Description

DashboardController.listActiveGoals(req, res)
	•	Retrieves all goals for the authenticated user with status = 'active'.
	•	Aggregates:
	•	totalTaskHours = sum of all task estimatedHours under that goal.
	•	doneTaskHours = sum of completed task hours.
	•	progress = doneTaskHours / totalTaskHours.
	•	Returns simplified list optimized for dashboard display.

⸻

Involved Models

Model	Used For
GoalModel	Retrieve all active goals.
MilestoneModel	Get milestones under each goal.
TaskModel	Aggregate task completion per goal.


⸻

Side Effects
	•	None (read-only).
	•	May update or warm a dashboard cache entry for the user.

⸻

Response Examples

✅ 200 OK

{
  "data": [
    {
      "id": "g_001",
      "title": "Build MVP",
      "priority": 1,
      "color": -65500,
      "totalTaskHours": 10,
      "doneTaskHours": 4
    },
    {
      "id": "g_002",
      "title": "Improve UX",
      "priority": 2,
      "color": -65500,
      "totalTaskHours": 5,
      "doneTaskHours": 1
    }
  ]
}


⸻

Edge Cases

Case	Behavior	Response
No active goals	Return empty array	200 OK

⸻

🧠 Summary Table

Endpoint	Controller Function	Models Used	Side Effects
GET /v1/tasks:query	queryTasksByDay	TaskModel, MilestoneModel, GoalModel	Read-only; daily task aggregation.
GET /v1/goals?status=active	listActiveGoals	GoalModel, MilestoneModel, TaskModel, UserModel	Read-only; conflict check on available hours.


⸻

🔐 Auth Middleware Integration
	•	Middleware ensures all dashboard data is scoped to the authenticated user.
	•	If authentication fails, response is:

{
  "error": { "code": 401, "message": "Unauthorized" }
}



⸻

🔄 Cross-Domain Interaction
	•	Tasks: Pulled from Milestone → Goal hierarchy for daily aggregation.
	•	Goals: Progress summary derived from underlying milestones and tasks.

⸻

🧩 Data Flow Overview

User
 ├── Goal (status: active)
 │    ├── Milestone
 │    │    └── Task (done/not_yet_done)
 │    └── Aggregated Metrics (Goal-level)
 └── availableHoursPerWeek

The DashboardController acts as a lightweight read aggregator:
	•	Joins across Goal, Milestone, and Task collections.
	•	Returns daily and weekly summaries efficiently.

⸻

This version assumes:
	•	The backend exposes a single client-facing endpoint (/v1/agent/goal/session:message)
	•	The backend internally calls the Python Agent Service’s /agent/run endpoint (Cloud Run → Cloud Run).
	•	Cloud Run IAM is configured so only your backend service account can call /agent/run.

⸻

💬 Chat Domain API

Purpose

Provide the frontend with access to the most recent agent chat session.
This endpoint allows the client to either resume the latest active session or start a new one if none exists.

⸻

1️⃣ Endpoint

GET /v1/agent/goal/session:latest

⸻

2️⃣ Expected Request

No body is required.

Headers

Authorization: Bearer <JWT>
Content-Type: application/json

⸻

3️⃣ Processing Logic

Step	Description	Related Model / Function
1️⃣	Verify JWT and extract userId.	AuthMiddleware
2️⃣	Query SessionState collection for user’s most recent active session (state='plan_generated' and sessionActive=true).	SessionStateRepository.findLatestActiveByUser()
3️⃣	If found → return session metadata and linked chatId.	—
4️⃣	If not found → bootstrap a new session + chat.	SessionStateRepository.create()
5️⃣	Return sessionId, chatId, and brief metadata to the client.	—


⸻

4️⃣ Response Examples

✅ 200 OK — Existing Active Session

{
  "data": {
    "sessionId": "sess_goal_002",
    "chatId": "chat_goal_002",
    "state": "plan_generated",
    "iteration": 2,
    "goalPreviewId": "gp_456",
    "context": {
      "availableHoursLeft": 18,
      "upcomingTasks": [
        {
          "id": "t_301",
          "title": "UI Layout",
          "goalId": "g_015",
          "date": "2025-11-07T15:00:00Z",
          "estimatedHours": 3
        }
      ]
    },
    "createdAt": "2025-11-03T12:00:00Z",
    "updatedAt": "2025-11-03T15:00:00Z"
  }
}


⸻

🆕 201 Created — No Active Session, New One Bootstrapped

{
  "data": {
    "sessionId": "sess_goal_003",
    "chatId": "chat_goal_003",
    "state": "plan_generated",
    "iteration": 0,
    "goalPreviewId": null,
    "context": {
      "availableHoursLeft": 22,
      "upcomingTasks": []
    },
    "createdAt": "2025-11-03T16:00:00Z"
  }
}


⸻

5️⃣ Edge Cases

Case	Behavior	Response
User has no active session create one.  201
User has multiple sessions (rare)	Return the most recently updated one.	200 OK
User not authenticated	Reject.	401 Unauthorized
Firestore read error	Return internal error.	500 Internal Error


⸻

6️⃣ Function Descriptions

Function	Description
ChatController.getLatestGoalSession(req, res)	Main handler. Fetches or creates the latest goal-planning session.
SessionStateRepository.findLatestActiveByUser(userId)	Finds most recent active session (sessionActive=true, sorted by updatedAt DESC).
SessionStateRepository.create(userId)	Creates a new SessionState document and links a new Chat.
ChatRepository.create(userId)	Creates empty chat document for new session.
ContextService.buildUserContext(userId)	Builds context snapshot (availableHoursLeft, upcomingTasks).


⸻

7️⃣ Involved Models

Model	Description
SessionState	Tracks lifecycle of each goal agent conversation and stores context.
Chat	Chat transcript document associated with a session.
User	Provides availableHoursPerWeek for context snapshot.
Task	Source of upcomingTasks for the session context.


⸻

8️⃣ Side Effects

Trigger	Effect
New session created	Inserts new SessionState and Chat records with initial context snapshot.
Existing session found	Returns latest without modifying.
Each session returned	Includes latest context snapshot for quick frontend display.


⸻

9️⃣ Security

/**
 * SECURITY NOTE:
 * - Requires JWT authentication (same as /v1/agent/goal/session:message).
 * - Returns sessions only for the authenticated user.
 * - Never exposes agent IAM credentials or direct access to /agent/run.
 */


⸻

🔟 Usage Example (Frontend Logic)

Chat Page startup logic:
	1.	GET /v1/agent/goal/session:latest
	•	If 200, use returned sessionId for /v1/agent/goal/session:message.
	•	If 201, use new session.
	2.	Then call /v1/agent/goal/session:message using that sessionId for all messages.

Excellent addition ✅ — that endpoint fits naturally within your Chat Domain (/v1/agent/goal/) alongside session:latest and session:message.

Below is the new endpoint specification that retrieves the full chat history of the current active session, consistent with your existing API style (as in api.md).

⸻
1️⃣ Endpoint

GET /v1/agent/goal/session/{sessionId}/history

Purpose

Fetch the entire chat transcript for a specific goal-planning session.
This enables the frontend chat page to restore previous messages when reopening the session.

⸻

Expected Request

Headers

Authorization: Bearer <JWT>
Content-Type: application/json

Path Parameter

Name	Type	Description
sessionId	string	The session ID of the current goal agent conversation.

No request body is required.

⸻

Processing Logic

Step	Description	Related Model / Function
1️⃣	Verify and decode JWT; extract userId.	authMiddleware
2️⃣	Ensure SessionState exists and belongs to the authenticated user.	SessionStateRepository.findById(sessionId)
3️⃣	Retrieve Chat document linked to this session.	ChatRepository.findBySessionId(sessionId)
4️⃣	Return all chat entries sorted chronologically.	
5️⃣	If no chat found, return empty array.	


⸻

Response Example

✅ 200 OK — Chat Found

{
  "data": {
    "sessionId": "sess_goal_002",
    "chatId": "chat_goal_002",
    "entries": [
      {
        "sender": "user",
        "message": "Let's add a new design milestone next week.",
        "timestamp": "2025-11-06T10:00:00Z"
      },
      {
        "sender": "agent",
        "message": "Got it. I’ll schedule the design milestone for next week without overlaps.",
        "timestamp": "2025-11-06T10:01:10Z"
      },
      {
        "sender": "user",
        "message": "Looks good. Can you finalize it?",
        "timestamp": "2025-11-06T10:02:00Z"
      },
      {
        "sender": "agent",
        "message": "Your plan has been finalized 🎯",
        "timestamp": "2025-11-06T10:02:30Z"
      }
    ]
  }
}


⸻

Edge Cases

Case	Behavior	Response
Session not found or belongs to another user	Reject	404 Not Found
No chat history yet	Return empty entries array	200 OK
Invalid or missing JWT	Reject	401 Unauthorized
Internal read error	Return internal error	500 Internal Server Error


⸻

Error Examples

❌ 404 Not Found

{
  "error": {
    "code": 404,
    "message": "Session 'sess_goal_999' not found or not owned by this user."
  }
}

❌ 401 Unauthorized

{
  "error": {
    "code": 401,
    "message": "Missing or invalid authentication token."
  }
}


⸻

Function Descriptions

Function	Description
ChatController.getSessionHistory(req, res)	Main controller to fetch full chat history.
SessionStateRepository.findById(sessionId)	Ensures session exists and belongs to current user.
ChatRepository.findBySessionId(sessionId)	Retrieves ordered chat entries from Firestore.


⸻

Involved Models

Model	Description
SessionState	Tracks session lifecycle, links to chatId.
Chat	Contains ordered chat entries {sender, message, timestamp}.
User	Validated from JWT.


⸻

Side Effects

None — this is a read-only endpoint.

⸻

Summary Table

Method	Path	Purpose	Controller	Models	Side Effects
GET	/v1/agent/goal/session/{sessionId}/history	Retrieve full chat transcript for a session	ChatController.getSessionHistory	SessionState, Chat, User	None


⸻

Security
	•	Requires valid JWT (same as /v1/agent/goal/session:message)
	•	Returns only sessions owned by the authenticated user
	•	Never exposes other users’ messages or metadata

⸻

Usage Example (Frontend)

When opening the Chat page:
	1.	Call GET /v1/agent/goal/session:latest → get sessionId
	2.	Then call GET /v1/agent/goal/session/{sessionId}/history → populate all chat messages in chronological order
	3.	Resume chat with /v1/agent/goal/session:message

⸻

🤖 Agent Domain API (Final Version – with Remote Session Bootstrap)

Purpose
Execute a single reasoning step with the Goal Planning Agent.
The backend converts user messages and context (goal preview, available time, upcoming tasks) into a structured ADK DTO and sends it to {AGENT_APP_URL}/run.

These will be passed as structured function_call parts in the same ADK-compatible way as goal_preview_context,
so your agent still receives a valid run payload, but with richer context for time planning and collision avoidance.

⸻

🧩 Final Agent Message DTO (Backend → Agent Service)

Endpoint

POST {AGENT_APP_URL}/run
Content-Type: application/json
Authorization: Bearer <IDENTITY_TOKEN>


⸻

DTO Schema

interface AgentMessageDTO {
  app_name: string;               // ADK app name ("goal_planning_agent")
  user_id: string;                // Firestore user ID
  session_id: string;             // Current backend session ID
  new_message: {
    role: "user";
    parts: AgentMessagePart[];    // Array of text + structured context parts
  };
}

type AgentMessagePart =
  | { text: string }
  | {
      function_call: {
        name:
          | "goal_preview_context"
          | "time_context"
          | "task_context";
        args: Record<string, any>;
      };
    };


⸻

Context Part Definitions

🟣 1. Goal Preview Context

Carries the latest GoalPreview JSON for reasoning/refinement.

{
  "function_call": {
    "name": "goal_preview_context",
    "args": {
      "goalPreview": {
        "goal": { "title": "Build Portfolio Website" },
        "milestones": [
          {
            "title": "Design Phase",
            "tasks": [
              { "title": "UI Layout", "date": "2025-11-10", "estimatedHours": 4 }
            ]
          }
        ],
        "iteration": 1,
        "status": "draft"
      }
    }
  }
}


⸻

🟢 2. Time Context

Provides available remaining working hours to guide scheduling.

{
  "function_call": {
    "name": "time_context",
    "args": {
      "availableHoursLeft": 18
    }
  }
}


⸻

🟡 3. Task Context

Lists user’s current scheduled tasks (used for time collision avoidance).

{
  "function_call": {
    "name": "task_context",
    "args": {
      "upcomingTasks": [
        {
          "id": "t_302",
          "title": "Team meeting",
          "date": "2025-11-10T15:00:00Z",
          "estimatedHours": 2,
          "goalId": "g_015",
          "done": false
        },
        {
          "id": "t_303",
          "title": "UX review",
          "date": "2025-11-11T09:00:00Z",
          "estimatedHours": 1
        }
      ]
    }
  }
}


⸻

✅ Example — Full DTO (Backend → Agent)

{
  "app_name": "goal_planning_agent",
  "user_id": "u_001",
  "session_id": "sess_goal_001",
  "new_message": {
    "role": "user",
    "parts": [
      { "text": "Please add a design task next week, but avoid overlapping with existing meetings." },
      {
        "function_call": {
          "name": "goal_preview_context",
          "args": {
            "goalPreview": {
              "goal": { "title": "Build Portfolio Website" },
              "milestones": [
                {
                  "title": "Design Phase",
                  "tasks": [
                    { "title": "UI Layout", "date": "2025-11-10", "estimatedHours": 4 }
                  ]
                }
              ],
              "iteration": 1,
              "status": "draft"
            }
          }
        }
      },
      {
        "function_call": {
          "name": "time_context",
          "args": { "availableHoursLeft": 18 }
        }
      },
      {
        "function_call": {
          "name": "task_context",
          "args": {
            "upcomingTasks": [
              {
                "id": "t_302",
                "title": "Team meeting",
                "date": "2025-11-10T15:00:00Z",
                "estimatedHours": 2
              }
            ]
          }
        }
      }
    ]
  },
}


⸻

🧠 How the Agent Uses These Context Parts

def extract_context(ctx):
    parts = ctx.input.parts
    preview = next((p.function_call.args.get("goalPreview")
                    for p in parts if hasattr(p, "function_call") and p.function_call.name == "goal_preview_context"), None)
    hours = next((p.function_call.args.get("availableHoursLeft")
                  for p in parts if hasattr(p, "function_call") and p.function_call.name == "time_context"), None)
    tasks = next((p.function_call.args.get("upcomingTasks")
                  for p in parts if hasattr(p, "function_call") and p.function_call.name == "task_context"), None)
    return preview, hours, tasks

Your PlanAgent or FinalizeAgent can then use these contexts to avoid time collisions and ensure tasks stay within the remaining allocation.

⸻

1️⃣ Endpoint

POST /v1/agent/goal/session:message

⸻

2️⃣ Expected Request (Client → Backend)

{
  "sessionId": "sess_goal_001",
  "message": "Add a design task next week but don’t overlap with existing meetings.",
  "goalPreview": {
    "goal": { "title": "Build Portfolio Website" },
    "milestones": [
      { "title": "Design Phase", "tasks": [{ "title": "UI Layout", "date": "2025-11-10" }] }
    ],
    "iteration": 1
  }
}

Headers:

Authorization: Bearer <JWT>
Content-Type: application/json


⸻

3️⃣ Backend → Agent (Final DTO)

{
  "app_name": "goal_planning_agent",
  "user_id": "u_001",
  "session_id": "sess_goal_001",
  "new_message": {
    "role": "user",
    "parts": [
      { "text": "Add a design task next week but don’t overlap with existing meetings." },
      {
        "function_call": {
          "name": "goal_preview_context",
          "args": { "goalPreview": { "goal": { "title": "Build Portfolio Website" } } }
        }
      },
      {
        "function_call": {
          "name": "time_context",
          "args": { "availableHoursLeft": 18 }
        }
      },
      {
        "function_call": {
          "name": "task_context",
          "args": {
            "upcomingTasks": [
              {
                "id": "t_301",
                "title": "Team meeting",
                "date": "2025-11-10T15:00:00Z",
                "estimatedHours": 2
              }
            ]
          }
        }
      }
    ]
  },
}


⸻

4️⃣ Processing Logic

Step	Description	Related Function
1️⃣	Validate JWT → extract userId.	authMiddleware
2️⃣	Verify session ownership and status (sessionActive=true).	SessionStateRepository.findById()
3️⃣	If session is new (iteration == 0), bootstrap remote session.	AgentService.initRemoteSession()
4️⃣	Fetch availableHoursLeft + upcomingTasks for context.	ContextService.buildUserContext(userId)
5️⃣	Build full DTO (text + goalPreview + time + tasks).	AgentService.buildDTO()
6️⃣	Send DTO → {AGENT_APP_URL}/run.	AgentService.invokeAgentRun()
7️⃣	Parse agent output and apply backend-side actions.	—
8️⃣	Save messages in Chat + update SessionState.	ChatRepository.append(), SessionStateRepository.update()
9️⃣	Return structured reply to client.	—


⸻

5️⃣ Response Examples

✅ 200 OK — Plan Refined

{
  "sessionId": "sess_goal_001",
  "reply": "I’ve added the new design task without overlapping with your meeting.",
  "action": {
    "type": "save_preview",
    "payload": {
      "goalPreview": {
        "goal": { "title": "Build Portfolio Website" },
        "milestones": [
          {
            "title": "Design Phase",
            "tasks": [
              { "title": "UI Layout", "date": "2025-11-10" },
              { "title": "Color Study", "date": "2025-11-11" }
            ]
          }
        ]
      }
    }
  },
  "state": {
    "state": "plan_iteration",
    "iteration": 2,
    "sessionActive": true
  }
}

✅ 200 OK — Goal Finalized

{
  "sessionId": "sess_goal_001",
  "reply": "I've finalized your goal schedule with no time conflicts.",
  "action": {
    "type": "finalize_goal",
    "payload": {
      "goalPreviewId": "gp_789",
      "goal": { "title": "Build Portfolio Website" },
      "milestones": [...]
    }
  },
  "state": { "state": "finalized", "iteration": 3, "sessionActive": false }
}


⸻

6️⃣ Function Descriptions

Function	Description
AgentController.handleGoalSessionMessage(req, res)	Main controller — validates, fetches context, builds DTO, invokes agent, and handles output.
AgentService.buildDTO(userId, sessionId, message, goalPreview, context)	Builds ADK-compliant DTO with text, goal preview, time context, and tasks.
AgentService.invokeAgentRun(payload)	Sends POST to {AGENT_APP_URL}/run.
ContextService.buildUserContext(userId)	Returns { availableHoursLeft, upcomingTasks }.
GoalPreviewRepository.save()	Upserts goal preview when agent refines plan.
GoalRepository.promoteFromPreview()	Converts preview → finalized goal.
ChatRepository.append()	Saves both user and agent messages.
SessionStateRepository.update()	Persists updated iteration and state.


⸻

7️⃣ Involved Models

Model	Purpose
SessionState	Tracks session lifecycle and current iteration.
Chat	Holds user/agent message history.
GoalPreview	Temporary structured plan.
Goal, Milestone, Task	Finalized plan entities.
User	Provides available hours.
Task	Supplies upcomingTasks for context.


⸻

8️⃣ Security

/**
 * SECURITY NOTES:
 * - JWT required for all client → backend calls.
 * - Backend authenticates itself to Agent Service via IAM identity token.
 * - Agent Service endpoints (/run, /apps/...) are private (Cloud Run IAM).
 * - Session ownership verified per message.
 */


⸻

9️⃣ Flow Summary

Step	Component	Action	Result
1️⃣	Frontend	POST /v1/agent/goal/session:message	Sends text and optional goal preview
2️⃣	Backend	Fetch user context (time + tasks)	Adds to DTO
3️⃣	Backend	POST {AGENT_APP_URL}/run	Sends ADK-compatible DTO
4️⃣	Agent	Generates structured output JSON	Returns reply + action + state
5️⃣	Backend	Applies persistence	Updates Firestore
6️⃣	Frontend	Receives structured reply	Updates chat UI


⸻

✅ Key Design Principles
	•	All contextual signals (goalPreview, availableHoursLeft, upcomingTasks)
are passed via ADK function_call parts, ensuring strict compliance.
	•	Backend is responsible for transforming user messages and computing context.
	•	The agent remains stateless — reasoning logic happens per request.
	•	This enables intelligent plan scheduling that respects user time limits and avoids conflicts.
