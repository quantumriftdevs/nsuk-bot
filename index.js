const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// Session storage (in-memory for MVP)
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { step: 'menu', data: {} };
  }
  return sessions[phone];
}

function resetSession(phone) {
  sessions[phone] = { step: 'menu', data: {} };
}

// CGPA Calculator
function calculateGPA(courses) {
  const gradePoints = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };
  let totalPoints = 0;
  let totalUnits = 0;
  courses.forEach(c => {
    const gp = gradePoints[c.grade.toUpperCase()] ?? 0;
    totalPoints += gp * c.units;
    totalUnits += c.units;
  });
  if (totalUnits === 0) return 0;
  return (totalPoints / totalUnits).toFixed(2);
}

function getClass(cgpa) {
  const g = parseFloat(cgpa);
  if (g >= 4.50) return "First Class";
  if (g >= 3.50) return "Second Class Upper";
  if (g >= 2.40) return "Second Class Lower";
  if (g >= 1.50) return "Third Class";
  return "Pass";
}

async function sendReply(to, message) {
  try {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await twilioClient.messages.create({
      from: "whatsapp:" + process.env.TWILIO_WHATSAPP_NUMBER,
      to: "whatsapp:" + to,
      body: message
    });
  } catch (err) {
    console.error('SendReply error:', err.message);
  }
}

function mainMenu() {
  return "👋 Welcome to NSUK Bot!\n\nYour smart student assistant. What would you like to do?\n\n1️⃣ Calculate my CGPA\n2️⃣ Set a CGPA target\n3️⃣ Get portal/result alerts\n4️⃣ My profile\n\nReply with a number (1-4)";
}

app.post('/webhook', async (req, res) => {
  const message = req.body.Body.trim();
  const from = req.body.From.replace('whatsapp:', '');
  const lower = message.toLowerCase();

  res.sendStatus(200);

  const session = getSession(from);

  try {
    // Reset anytime
    if (lower === 'menu' || lower === 'home' || lower === 'start') {
      resetSession(from);
      await sendReply(from, mainMenu());
      return;
    }

    // MAIN MENU
    if (session.step === 'menu') {
      if (message === '1') {
        session.step = 'cgpa_how_many';
        session.data.courses = [];
        await sendReply(from, "📊 CGPA Calculator\n\nHow many courses did you take this semester?");
        return;
      }
      if (message === '2') {
        session.step = 'target_current';
        await sendReply(from, "🎯 CGPA Target Planner\n\nWhat is your current CGPA? (e.g. 3.20)");
        return;
      }
      if (message === '3') {
        session.step = 'alerts_dept';
        await sendReply(from, "🔔 Portal & Result Alerts\n\nWhat is your department? (e.g. Computer Science, Medicine, Law)");
        return;
      }
      if (message === '4') {
        const p = session.data.profile;
        if (!p) {
          await sendReply(from, "📋 No profile saved yet.\n\nUse the menu options to calculate your CGPA and your profile will be saved automatically.\n\nType *menu* to go back.");
          return;
        }
        await sendReply(from, "📋 Your Profile\n\nDepartment: " + (p.dept || 'Not set') + "\nLevel: " + (p.level || 'Not set') + "\nCGPA: " + (p.cgpa || 'Not calculated') + "\nClass: " + (p.class || 'Not calculated') + "\nAlerts: " + (p.alerts || 'Not subscribed') + "\n\nType *menu* to go back.");
        return;
      }
      await sendReply(from, mainMenu());
      return;
    }

    // CGPA FLOW
    if (session.step === 'cgpa_how_many') {
      const num = parseInt(message);
      if (isNaN(num) || num < 1 || num > 20) {
        await sendReply(from, "Please enter a valid number of courses (1-20).");
        return;
      }
      session.data.totalCourses = num;
      session.data.courses = [];
      session.step = 'cgpa_course_code';
      await sendReply(from, "Course 1 of " + num + "\n\nEnter course code:\n(e.g. CSC201)");
      return;
    }

    if (session.step === 'cgpa_course_code') {
      session.data.currentCourse = { code: message.toUpperCase() };
      session.step = 'cgpa_course_units';
      await sendReply(from, "Credit units for " + session.data.currentCourse.code + "?\n(e.g. 3)");
      return;
    }

    if (session.step === 'cgpa_course_units') {
      const units = parseInt(message);
      if (isNaN(units) || units < 1 || units > 6) {
        await sendReply(from, "Please enter valid credit units (1-6).");
        return;
      }
      session.data.currentCourse.units = units;
      session.step = 'cgpa_course_grade';
      await sendReply(from, "Grade for " + session.data.currentCourse.code + "?\n\nReply with: A, B, C, D, E, or F");
      return;
    }

    if (session.step === 'cgpa_course_grade') {
      const grade = message.toUpperCase();
      if (!['A', 'B', 'C', 'D', 'E', 'F'].includes(grade)) {
        await sendReply(from, "Please reply with A, B, C, D, E, or F only.");
        return;
      }
      session.data.currentCourse.grade = grade;
      session.data.courses.push(session.data.currentCourse);

      const done = session.data.courses.length;
      const total = session.data.totalCourses;

      if (done < total) {
        session.step = 'cgpa_course_code';
        await sendReply(from, "Course " + (done + 1) + " of " + total + "\n\nEnter course code:");
        return;
      }

      // Calculate
      const gpa = calculateGPA(session.data.courses);
      const cls = getClass(gpa);

      let summary = "📊 Your Results\n\n";
      session.data.courses.forEach(c => {
        summary += c.code + " — " + c.grade + " (" + c.units + " units)\n";
      });
      summary += "\nSemester GPA: " + gpa;
      summary += "\nDegree Class: " + cls;
      summary += "\n\nWant to save this to your profile? Reply YES or NO.";

      session.data.lastGPA = gpa;
      session.data.lastClass = cls;
      session.step = 'cgpa_save';
      await sendReply(from, summary);
      return;
    }

    if (session.step === 'cgpa_save') {
      if (lower === 'yes') {
        if (!session.data.profile) session.data.profile = {};
        session.data.profile.cgpa = session.data.lastGPA;
        session.data.profile.class = session.data.lastClass;
        await sendReply(from, "✅ Saved to your profile!\n\nType *menu* to go back.");
      } else {
        await sendReply(from, "Okay, not saved.\n\nType *menu* to go back.");
      }
      session.step = 'menu';
      return;
    }

    // TARGET PLANNER FLOW
    if (session.step === 'target_current') {
      const current = parseFloat(message);
      if (isNaN(current) || current < 0 || current > 5) {
        await sendReply(from, "Please enter a valid CGPA between 0.00 and 5.00.");
        return;
      }
      session.data.currentCGPA = current;
      session.step = 'target_goal';
      await sendReply(from, "What CGPA are you targeting? (e.g. 4.50)");
      return;
    }

    if (session.step === 'target_goal') {
      const target = parseFloat(message);
      if (isNaN(target) || target < 0 || target > 5) {
        await sendReply(from, "Please enter a valid target CGPA between 0.00 and 5.00.");
        return;
      }
      session.data.targetCGPA = target;
      session.step = 'target_units_done';
      await sendReply(from, "How many credit units have you completed so far?");
      return;
    }

    if (session.step === 'target_units_done') {
      const done = parseInt(message);
      if (isNaN(done) || done < 0) {
        await sendReply(from, "Please enter a valid number of units completed.");
        return;
      }
      session.data.unitsDone = done;
      session.step = 'target_units_left';
      await sendReply(from, "How many credit units do you have remaining?");
      return;
    }

    if (session.step === 'target_units_left') {
      const left = parseInt(message);
      if (isNaN(left) || left < 1) {
        await sendReply(from, "Please enter a valid number of remaining units.");
        return;
      }

      const current = session.data.currentCGPA;
      const target = session.data.targetCGPA;
      const done = session.data.unitsDone;

      const totalUnits = done + left;
      const requiredTotal = target * totalUnits;
      const alreadyEarned = current * done;
      const neededPoints = requiredTotal - alreadyEarned;
      const requiredGP = (neededPoints / left).toFixed(2);

      let advice = "";
      const gp = parseFloat(requiredGP);
      if (gp > 5) {
        advice = "❌ This target is no longer mathematically achievable with the remaining units. Consider adjusting your goal.";
      } else if (gp >= 4.5) {
        advice = "💪 You need mostly A's — very ambitious but achievable with serious focus.";
      } else if (gp >= 3.5) {
        advice = "📚 You need a mix of A's and B's — very doable with consistent effort.";
      } else if (gp >= 2.5) {
        advice = "✅ You need mostly B's and C's — achievable with steady work.";
      } else {
        advice = "😊 You're in a comfortable position — keep it up!";
      }

      await sendReply(from,
        "🎯 CGPA Target Plan\n\nCurrent CGPA: " + current + "\nTarget CGPA: " + target + "\nUnits remaining: " + left + "\n\nYou need an average of *" + requiredGP + " GP* per unit in your remaining courses.\n\n" + advice + "\n\nType *menu* to go back."
      );
      session.step = 'menu';
      return;
    }

    // ALERTS FLOW
    if (session.step === 'alerts_dept') {
      session.data.alertDept = message;
      session.step = 'alerts_level';
      await sendReply(from, "What level are you? (100, 200, 300, 400, or 500)");
      return;
    }

    if (session.step === 'alerts_level') {
      const level = parseInt(message);
      if (![100, 200, 300, 400, 500].includes(level)) {
        await sendReply(from, "Please enter a valid level: 100, 200, 300, 400, or 500.");
        return;
      }
      session.data.alertLevel = level;
      if (!session.data.profile) session.data.profile = {};
      session.data.profile.dept = session.data.alertDept;
      session.data.profile.level = level;
      session.data.profile.alerts = session.data.alertDept + " " + level + "L";
      session.step = 'menu';
      await sendReply(from,
        "✅ You're now subscribed to alerts for:\n\n" + session.data.alertDept + " — " + level + " Level\n\nWe'll notify you when:\n🔔 Results are released\n🔔 Portal opens for registration\n🔔 Important announcements drop\n\nType *menu* to go back."
      );
      return;
    }

    // Fallback
    await sendReply(from, "Type *menu* to see what I can do for you 👋");

  } catch (err) {
    console.error('Webhook error:', err.message);
    await sendReply(from, 'Something went wrong, try again 🙏');
  }
});

app.get('/', (req, res) => res.send('NSUK Bot is running!'));

app.listen(3000, () => console.log('NSUK Bot running on port 3000'));
