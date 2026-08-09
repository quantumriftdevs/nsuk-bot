const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

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

const gradePoints = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };

function calculateGPA(courses) {
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

// Sample course data - replace with real NSUK data after pitch
const courseData = {
  "computer science": {
    100: {
      first: [
        { code: "CSC101", title: "Introduction to Computer Science", units: 3, required: true },
        { code: "MTH101", title: "Elementary Mathematics I", units: 3, required: true },
        { code: "PHY101", title: "General Physics I", units: 3, required: true },
        { code: "ENG101", title: "Use of English I", units: 2, required: true },
        { code: "GST101", title: "Nigerian Peoples and Culture", units: 2, required: true }
      ],
      second: [
        { code: "CSC102", title: "Introduction to Programming", units: 3, required: true },
        { code: "MTH102", title: "Elementary Mathematics II", units: 3, required: true },
        { code: "PHY102", title: "General Physics II", units: 3, required: true },
        { code: "ENG102", title: "Use of English II", units: 2, required: true },
        { code: "GST102", title: "Logic and Philosophy", units: 2, required: true }
      ]
    },
    200: {
      first: [
        { code: "CSC201", title: "Computer Programming I", units: 3, required: true },
        { code: "CSC203", title: "Computer Architecture", units: 3, required: true },
        { code: "MTH201", title: "Mathematical Methods", units: 3, required: true },
        { code: "STA201", title: "Probability and Statistics", units: 3, required: true },
        { code: "GST201", title: "Peace and Conflict Resolution", units: 2, required: true }
      ],
      second: [
        { code: "CSC202", title: "Computer Programming II", units: 3, required: true },
        { code: "CSC204", title: "Data Structures", units: 3, required: true },
        { code: "CSC206", title: "Systems Analysis", units: 2, required: true },
        { code: "MTH202", title: "Linear Algebra", units: 3, required: true },
        { code: "GST202", title: "Entrepreneurship", units: 2, required: true }
      ]
    },
    300: {
      first: [
        { code: "CSC301", title: "Operating Systems", units: 3, required: true },
        { code: "CSC303", title: "Database Management", units: 3, required: true },
        { code: "CSC305", title: "Software Engineering", units: 3, required: true },
        { code: "CSC307", title: "Computer Networks", units: 3, required: true },
        { code: "CSC309", title: "Numerical Methods", units: 2, required: true }
      ],
      second: [
        { code: "CSC302", title: "Compiler Construction", units: 3, required: true },
        { code: "CSC304", title: "Artificial Intelligence", units: 3, required: true },
        { code: "CSC306", title: "Human Computer Interaction", units: 2, required: true },
        { code: "CSC308", title: "Computer Graphics", units: 2, required: true },
        { code: "CSC310", title: "Industrial Training", units: 6, required: true }
      ]
    },
    400: {
      first: [
        { code: "CSC401", title: "Final Year Project I", units: 3, required: true },
        { code: "CSC403", title: "Information Security", units: 3, required: true },
        { code: "CSC405", title: "Mobile Computing", units: 3, required: true },
        { code: "CSC407", title: "E-Commerce", units: 2, required: true },
        { code: "CSC409", title: "Cloud Computing", units: 2, required: true }
      ],
      second: [
        { code: "CSC402", title: "Final Year Project II", units: 6, required: true },
        { code: "CSC404", title: "Machine Learning", units: 3, required: true },
        { code: "CSC406", title: "IT Project Management", units: 2, required: true },
        { code: "CSC408", title: "Professional Ethics", units: 2, required: true }
      ]
    }
  }
};

async function transcribeVoiceNote(mediaUrl) {
  try {
    const authHeader = "Basic " + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN).toString('base64');
    const audioResponse = await fetch(mediaUrl, {
      headers: { "Authorization": authHeader }
    });
    const audioBuffer = await audioResponse.arrayBuffer();
    const audioBytes = Buffer.from(audioBuffer);

    const formData = new FormData();
    const blob = new Blob([audioBytes], { type: 'audio/ogg' });
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'en');

    const groqResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.GROQ_API_KEY
      },
      body: formData
    });

    const result = await groqResponse.json();
    console.log('Transcription result:', JSON.stringify(result));
    return result.text || null;
  } catch (err) {
    console.error('Transcription error:', err.message);
    return null;
  }
}

async function understandMessage(message, currentStep, sessionData) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are an assistant helping Nigerian university students at NSUK (Nasarawa State University Keffi). You understand English, Nigerian Pidgin, and informal student language. Current conversation step: " + currentStep + ". Student profile so far: " + JSON.stringify(sessionData) + ". Extract the relevant information from the student's message and return ONLY JSON. For menu selection return {\"intent\": \"cgpa\" or \"target\" or \"alerts\" or \"profile\" or \"courses\"}. For department return {\"department\": \"name\"}. For level return {\"level\": number}. For semester return {\"semester\": \"first\" or \"second\"}. For number input return {\"number\": value}. For grade return {\"grade\": \"A\" or \"B\" or \"C\" or \"D\" or \"E\" or \"F\"}. For yes/no return {\"answer\": \"yes\" or \"no\"}. For course code return {\"code\": \"XXX000\"}. If unclear return {\"unclear\": true}."
        },
        {
          role: "user",
          content: message
        }
      ],
      max_tokens: 150,
      temperature: 0
    })
  });

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';
  try {
    const match = raw.match(/\{.*\}/s);
    return match ? JSON.parse(match[0]) : { unclear: true };
  } catch {
    return { unclear: true };
  }
}

function getCourses(department, level, semester) {
  const dept = department.toLowerCase();
  const sem = semester.toLowerCase();
  const deptData = courseData[dept];
  if (!deptData) return null;
  const levelData = deptData[level];
  if (!levelData) return null;
  return levelData[sem] || null;
}

function formatCourses(courses, department, level, semester) {
  let msg = "📚 " + department.toUpperCase() + " — " + level + " Level, " + semester.charAt(0).toUpperCase() + semester.slice(1) + " Semester\n\n";
  msg += "Courses to register:\n\n";
  let totalUnits = 0;
  courses.forEach((c, i) => {
    msg += (i + 1) + ". " + c.code + " — " + c.title + " (" + c.units + " units)\n";
    totalUnits += c.units;
  });
  msg += "\nTotal Units: " + totalUnits;
  msg += "\n\nType *menu* to go back or ask me anything about these courses.";
  return msg;
}

function mainMenu() {
  return "👋 Welcome to NSUK Bot!\n\nYour smart student assistant. What would you like to do?\n\n1️⃣ What should I register this semester?\n2️⃣ Calculate my CGPA\n3️⃣ Set a CGPA target\n4️⃣ Get portal/result alerts\n5️⃣ My profile\n\nReply with a number or just tell me what you need in your own words.";
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

app.post('/webhook', async (req, res) => {
  let message = req.body.Body ? req.body.Body.trim() : '';
  const from = req.body.From.replace('whatsapp:', '');
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  res.sendStatus(200);

  const session = getSession(from);

  try {
    // Handle voice notes
    if (mediaUrl && mediaType && mediaType.includes('audio')) {
      await sendReply(from, "🎤 Got your voice note, transcribing...");
      const transcribed = await transcribeVoiceNote(mediaUrl);
      if (transcribed) {
        message = transcribed;
        console.log('Transcribed:', message);
        await sendReply(from, "I heard: \"" + message + "\"\n\nProcessing...");
      } else {
        await sendReply(from, "Sorry, I could not transcribe that voice note. Please try typing your message.");
        return;
      }
    }

    if (!message) {
      await sendReply(from, mainMenu());
      return;
    }

    const lower = message.toLowerCase();

    if (lower === 'menu' || lower === 'home' || lower === 'start' || lower === 'hi' || lower === 'hello') {
      resetSession(from);
      await sendReply(from, mainMenu());
      return;
    }

    // Use Groq to understand the message
    const understood = await understandMessage(message, session.step, session.data);
    console.log('Understood:', JSON.stringify(understood));

    // MAIN MENU
    if (session.step === 'menu') {
      if (message === '1' || understood.intent === 'courses') {
        session.step = 'courses_dept';
        await sendReply(from, "📚 Course Registration Guide\n\nWhat is your department?\n(e.g. Computer Science, Accounting, Medicine, Law)");
        return;
      }
      if (message === '2' || understood.intent === 'cgpa') {
        session.step = 'cgpa_how_many';
        session.data.courses = [];
        await sendReply(from, "📊 CGPA Calculator\n\nHow many courses did you take this semester?");
        return;
      }
      if (message === '3' || understood.intent === 'target') {
        session.step = 'target_current';
        await sendReply(from, "🎯 CGPA Target Planner\n\nWhat is your current CGPA? (e.g. 3.20)");
        return;
      }
      if (message === '4' || understood.intent === 'alerts') {
        session.step = 'alerts_dept';
        await sendReply(from, "🔔 Portal and Result Alerts\n\nWhat is your department?");
        return;
      }
      if (message === '5' || understood.intent === 'profile') {
        const p = session.data.profile;
        if (!p) {
          await sendReply(from, "📋 No profile saved yet.\n\nUse the menu to get started.\n\nType *menu* to go back.");
          return;
        }
        await sendReply(from, "📋 Your Profile\n\nDepartment: " + (p.dept || 'Not set') + "\nLevel: " + (p.level || 'Not set') + "\nSemester: " + (p.semester || 'Not set') + "\nCGPA: " + (p.cgpa || 'Not calculated') + "\nClass: " + (p.class || 'Not calculated') + "\nAlerts: " + (p.alerts || 'Not subscribed') + "\n\nType *menu* to go back.");
        return;
      }
      await sendReply(from, mainMenu());
      return;
    }

    // COURSE REGISTRATION FLOW
    if (session.step === 'courses_dept') {
      const dept = understood.department || message;
      session.data.coursesDept = dept;
      session.step = 'courses_level';
      await sendReply(from, "What level are you?\n(100, 200, 300, 400, or 500)");
      return;
    }

    if (session.step === 'courses_level') {
      const level = understood.level || parseInt(message);
      if (![100, 200, 300, 400, 500].includes(level)) {
        await sendReply(from, "Please enter a valid level: 100, 200, 300, 400, or 500.");
        return;
      }
      session.data.coursesLevel = level;
      session.step = 'courses_semester';
      await sendReply(from, "Which semester?\n\nReply *first* or *second*");
      return;
    }

    if (session.step === 'courses_semester') {
      const sem = understood.semester || (lower.includes('first') || lower === '1' ? 'first' : lower.includes('second') || lower === '2' ? 'second' : null);
      if (!sem) {
        await sendReply(from, "Please reply with *first* or *second*.");
        return;
      }
      session.data.coursesSemester = sem;

      const courses = getCourses(session.data.coursesDept, session.data.coursesLevel, sem);

      if (!courses) {
        await sendReply(from, "I don't have the course list for " + session.data.coursesDept + " " + session.data.coursesLevel + " Level yet.\n\nWe are loading all NSUK departments soon. For now I have Computer Science.\n\nType *menu* to go back.");
        session.step = 'menu';
        return;
      }

      if (!session.data.profile) session.data.profile = {};
      session.data.profile.dept = session.data.coursesDept;
      session.data.profile.level = session.data.coursesLevel;
      session.data.profile.semester = sem;

      session.step = 'menu';
      await sendReply(from, formatCourses(courses, session.data.coursesDept, session.data.coursesLevel, sem));
      return;
    }

    // CGPA FLOW
    if (session.step === 'cgpa_how_many') {
      const num = understood.number || parseInt(message);
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
      const code = understood.code || message.toUpperCase();
      session.data.currentCourse = { code: code };
      session.step = 'cgpa_course_units';
      await sendReply(from, "Credit units for " + code + "?\n(e.g. 3)");
      return;
    }

    if (session.step === 'cgpa_course_units') {
      const units = understood.number || parseInt(message);
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
      const grade = understood.grade || message.toUpperCase();
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
      const answer = understood.answer || lower;
      if (answer === 'yes') {
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
      const current = understood.number || parseFloat(message);
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
      const target = understood.number || parseFloat(message);
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
      const done = understood.number || parseInt(message);
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
      const left = understood.number || parseInt(message);
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
        advice = "❌ This target is no longer mathematically achievable. Consider adjusting your goal.";
      } else if (gp >= 4.5) {
        advice = "💪 You need mostly A's — very ambitious but achievable with serious focus.";
      } else if (gp >= 3.5) {
        advice = "📚 You need a mix of A's and B's — very doable with consistent effort.";
      } else if (gp >= 2.5) {
        advice = "✅ You need mostly B's and C's — achievable with steady work.";
      } else {
        advice = "😊 You are in a comfortable position — keep it up!";
      }

      await sendReply(from,
        "🎯 CGPA Target Plan\n\nCurrent CGPA: " + current + "\nTarget CGPA: " + target + "\nUnits remaining: " + left + "\n\nYou need an average of " + requiredGP + " GP per unit in your remaining courses.\n\n" + advice + "\n\nType *menu* to go back."
      );
      session.step = 'menu';
      return;
    }

    // ALERTS FLOW
    if (session.step === 'alerts_dept') {
      const dept = understood.department || message;
      session.data.alertDept = dept;
      session.step = 'alerts_level';
      await sendReply(from, "What level are you? (100, 200, 300, 400, or 500)");
      return;
    }

    if (session.step === 'alerts_level') {
      const level = understood.level || parseInt(message);
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
        "✅ Subscribed to alerts for:\n\n" + session.data.alertDept + " — " + level + " Level\n\nYou will be notified when:\n🔔 Results are released\n🔔 Portal opens for registration\n🔔 Important announcements drop\n\nType *menu* to go back."
      );
      return;
    }

    await sendReply(from, "Type *menu* to see what I can do for you 👋");

  } catch (err) {
    console.error('Webhook error:', err.message);
    await sendReply(from, 'Something went wrong, try again 🙏');
  }
});

app.get('/', (req, res) => res.send('NSUK Bot is running!'));

app.listen(3000, () => console.log('NSUK Bot running on port 3000'));    },
    300: {
      first: [
        { code: "CSC301", title: "Operating Systems", units: 3, required: true },
        { code: "CSC303", title: "Database Management", units: 3, required: true },
        { code: "CSC305", title: "Software Engineering", units: 3, required: true },
        { code: "CSC307", title: "Computer Networks", units: 3, required: true },
        { code: "CSC309", title: "Numerical Methods", units: 2, required: true }
      ],
      second: [
        { code: "CSC302", title: "Compiler Construction", units: 3, required: true },
        { code: "CSC304", title: "Artificial Intelligence", units: 3, required: true },
        { code: "CSC306", title: "Human Computer Interaction", units: 2, required: true },
        { code: "CSC308", title: "Computer Graphics", units: 2, required: true },
        { code: "CSC310", title: "Industrial Training", units: 6, required: true }
      ]
    },
    400: {
      first: [
        { code: "CSC401", title: "Final Year Project I", units: 3, required: true },
        { code: "CSC403", title: "Information Security", units: 3, required: true },
        { code: "CSC405", title: "Mobile Computing", units: 3, required: true },
        { code: "CSC407", title: "E-Commerce", units: 2, required: true },
        { code: "CSC409", title: "Cloud Computing", units: 2, required: true }
      ],
      second: [
        { code: "CSC402", title: "Final Year Project II", units: 6, required: true },
        { code: "CSC404", title: "Machine Learning", units: 3, required: true },
        { code: "CSC406", title: "IT Project Management", units: 2, required: true },
        { code: "CSC408", title: "Professional Ethics", units: 2, required: true }
      ]
    }
  }
};

async function transcribeVoiceNote(mediaUrl) {
  try {
    const authHeader = "Basic " + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN).toString('base64');
    const audioResponse = await fetch(mediaUrl, {
      headers: { "Authorization": authHeader }
    });
    const audioBuffer = await audioResponse.arrayBuffer();
    const audioBytes = Buffer.from(audioBuffer);

    const formData = new FormData();
    const blob = new Blob([audioBytes], { type: 'audio/ogg' });
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'en');

    const groqResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.GROQ_API_KEY
      },
      body: formData
    });

    const result = await groqResponse.json();
    console.log('Transcription result:', JSON.stringify(result));
    return result.text || null;
  } catch (err) {
    console.error('Transcription error:', err.message);
    return null;
  }
}

async function understandMessage(message, currentStep, sessionData) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "You are an assistant helping Nigerian university students at NSUK (Nasarawa State University Keffi). You understand English, Nigerian Pidgin, and informal student language. Current conversation step: " + currentStep + ". Student profile so far: " + JSON.stringify(sessionData) + ". Extract the relevant information from the student's message and return ONLY JSON. For menu selection return {\"intent\": \"cgpa\" or \"target\" or \"alerts\" or \"profile\" or \"courses\"}. For department return {\"department\": \"name\"}. For level return {\"level\": number}. For semester return {\"semester\": \"first\" or \"second\"}. For number input return {\"number\": value}. For grade return {\"grade\": \"A\" or \"B\" or \"C\" or \"D\" or \"E\" or \"F\"}. For yes/no return {\"answer\": \"yes\" or \"no\"}. For course code return {\"code\": \"XXX000\"}. If unclear return {\"unclear\": true}."
        },
        {
          role: "user",
          content: message
        }
      ],
      max_tokens: 150,
      temperature: 0
    })
  });

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';
  try {
    const match = raw.match(/\{.*\}/s);
    return match ? JSON.parse(match[0]) : { unclear: true };
  } catch {
    return { unclear: true };
  }
}

function getCourses(department, level, semester) {
  const dept = department.toLowerCase();
  const sem = semester.toLowerCase();
  const deptData = courseData[dept];
  if (!deptData) return null;
  const levelData = deptData[level];
  if (!levelData) return null;
  return levelData[sem] || null;
}

function formatCourses(courses, department, level, semester) {
  let msg = "📚 " + department.toUpperCase() + " — " + level + " Level, " + semester.charAt(0).toUpperCase() + semester.slice(1) + " Semester\n\n";
  msg += "Courses to register:\n\n";
  let totalUnits = 0;
  courses.forEach((c, i) => {
    msg += (i + 1) + ". " + c.code + " — " + c.title + " (" + c.units + " units)\n";
    totalUnits += c.units;
  });
  msg += "\nTotal Units: " + totalUnits;
  msg += "\n\nType *menu* to go back or ask me anything about these courses.";
  return msg;
}

function mainMenu() {
  return "👋 Welcome to NSUK Bot!\n\nYour smart student assistant. What would you like to do?\n\n1️⃣ What should I register this semester?\n2️⃣ Calculate my CGPA\n3️⃣ Set a CGPA target\n4️⃣ Get portal/result alerts\n5️⃣ My profile\n\nReply with a number or just tell me what you need in your own words.";
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

app.post('/webhook', async (req, res) => {
  let message = req.body.Body ? req.body.Body.trim() : '';
  const from = req.body.From.replace('whatsapp:', '');
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  res.sendStatus(200);

  const session = getSession(from);

  try {
    // Handle voice notes
    if (mediaUrl && mediaType && mediaType.includes('audio')) {
      await sendReply(from, "🎤 Got your voice note, transcribing...");
      const transcribed = await transcribeVoiceNote(mediaUrl);
      if (transcribed) {
        message = transcribed;
        console.log('Transcribed:', message);
        await sendReply(from, "I heard: \"" + message + "\"\n\nProcessing...");
      } else {
        await sendReply(from, "Sorry, I could not transcribe that voice note. Please try typing your message.");
        return;
      }
    }

    if (!message) {
      await sendReply(from, mainMenu());
      return;
    }

    const lower = message.toLowerCase();

    if (lower === 'menu' || lower === 'home' || lower === 'start' || lower === 'hi' || lower === 'hello') {
      resetSession(from);
      await sendReply(from, mainMenu());
      return;
    }

    // Use Groq to understand the message
    const understood = await understandMessage(message, session.step, session.data);
    console.log('Understood:', JSON.stringify(understood));

    // MAIN MENU
    if (session.step === 'menu') {
      if (message === '1' || understood.intent === 'courses') {
        session.step = 'courses_dept';
        await sendReply(from, "📚 Course Registration Guide\n\nWhat is your department?\n(e.g. Computer Science, Accounting, Medicine, Law)");
        return;
      }
      if (message === '2' || understood.intent === 'cgpa') {
        session.step = 'cgpa_how_many';
        session.data.courses = [];
        await sendReply(from, "📊 CGPA Calculator\n\nHow many courses did you take this semester?");
        return;
      }
      if (message === '3' || understood.intent === 'target') {
        session.step = 'target_current';
        await sendReply(from, "🎯 CGPA Target Planner\n\nWhat is your current CGPA? (e.g. 3.20)");
        return;
      }
      if (message === '4' || understood.intent === 'alerts') {
        session.step = 'alerts_dept';
        await sendReply(from, "🔔 Portal and Result Alerts\n\nWhat is your department?");
        return;
      }
      if (message === '5' || understood.intent === 'profile') {
        const p = session.data.profile;
        if (!p) {
          await sendReply(from, "📋 No profile saved yet.\n\nUse the menu to get started.\n\nType *menu* to go back.");
          return;
        }
        await sendReply(from, "📋 Your Profile\n\nDepartment: " + (p.dept || 'Not set') + "\nLevel: " + (p.level || 'Not set') + "\nSemester: " + (p.semester || 'Not set') + "\nCGPA: " + (p.cgpa || 'Not calculated') + "\nClass: " + (p.class || 'Not calculated') + "\nAlerts: " + (p.alerts || 'Not subscribed') + "\n\nType *menu* to go back.");
        return;
      }
      await sendReply(from, mainMenu());
      return;
    }

    // COURSE REGISTRATION FLOW
    if (session.step === 'courses_dept') {
      const dept = understood.department || message;
      session.data.coursesDept = dept;
      session.step = 'courses_level';
      await sendReply(from, "What level are you?\n(100, 200, 300, 400, or 500)");
      return;
    }

    if (session.step === 'courses_level') {
      const level = understood.level || parseInt(message);
      if (![100, 200, 300, 400, 500].includes(level)) {
        await sendReply(from, "Please enter a valid level: 100, 200, 300, 400, or 500.");
        return;
      }
      session.data.coursesLevel = level;
      session.step = 'courses_semester';
      await sendReply(from, "Which semester?\n\nReply *first* or *second*");
      return;
    }

    if (session.step === 'courses_semester') {
      const sem = understood.semester || (lower.includes('first') || lower === '1' ? 'first' : lower.includes('second') || lower === '2' ? 'second' : null);
      if (!sem) {
        await sendReply(from, "Please reply with *first* or *second*.");
        return;
      }
      session.data.coursesSemester = sem;

      const courses = getCourses(session.data.coursesDept, session.data.coursesLevel, sem);

      if (!courses) {
        await sendReply(from, "I don't have the course list for " + session.data.coursesDept + " " + session.data.coursesLevel + " Level yet.\n\nWe are loading all NSUK departments soon. For now I have Computer Science.\n\nType *menu* to go back.");
        session.step = 'menu';
        return;
      }

      if (!session.data.profile) session.data.profile = {};
      session.data.profile.dept = session.data.coursesDept;
      session.data.profile.level = session.data.coursesLevel;
      session.data.profile.semester = sem;

      session.step = 'menu';
      await sendReply(from, formatCourses(courses, session.data.coursesDept, session.data.coursesLevel, sem));
      return;
    }

    // CGPA FLOW
    if (session.step === 'cgpa_how_many') {
      const num = understood.number || parseInt(message);
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
      const code = understood.code || message.toUpperCase();
      session.data.currentCourse = { code: code };
      session.step = 'cgpa_course_units';
      await sendReply(from, "Credit units for " + code + "?\n(e.g. 3)");
      return;
    }

    if (session.step === 'cgpa_course_units') {
      const units = understood.number || parseInt(message);
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
      const grade = understood.grade || message.toUpperCase();
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
      const answer = understood.answer || lower;
      if (answer === 'yes') {
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
      const current = understood.number || parseFloat(message);
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
      const target = understood.number || parseFloat(message);
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
      const done = understood.number || parseInt(message);
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
      const left = understood.number || parseInt(message);
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
        advice = "❌ This target is no longer mathematically achievable. Consider adjusting your goal.";
      } else if (gp >= 4.5) {
        advice = "💪 You need mostly A's — very ambitious but achievable with serious focus.";
      } else if (gp >= 3.5) {
        advice = "📚 You need a mix of A's and B's — very doable with consistent effort.";
      } else if (gp >= 2.5) {
        advice = "✅ You need mostly B's and C's — achievable with steady work.";
      } else {
        advice = "😊 You are in a comfortable position — keep it up!";
      }

      await sendReply(from,
        "🎯 CGPA Target Plan\n\nCurrent CGPA: " + current + "\nTarget CGPA: " + target + "\nUnits remaining: " + left + "\n\nYou need an average of " + requiredGP + " GP per unit in your remaining courses.\n\n" + advice + "\n\nType *menu* to go back."
      );
      session.step = 'menu';
      return;
    }

    // ALERTS FLOW
    if (session.step === 'alerts_dept') {
      const dept = understood.department || message;
      session.data.alertDept = dept;
      session.step = 'alerts_level';
      await sendReply(from, "What level are you? (100, 200, 300, 400, or 500)");
      return;
    }

    if (session.step === 'alerts_level') {
      const level = understood.level || parseInt(message);
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
        "✅ Subscribed to alerts for:\n\n" + session.data.alertDept + " — " + level + " Level\n\nYou will be notified when:\n🔔 Results are released\n🔔 Portal opens for registration\n🔔 Important announcements drop\n\nType *menu* to go back."
      );
      return;
    }

    await sendReply(from, "Type *menu* to see what I can do for you 👋");

  } catch (err) {
    console.error('Webhook error:', err.message);
    await sendReply(from, 'Something went wrong, try again 🙏');
  }
});

app.get('/', (req, res) => res.send('NSUK Bot is running!'));

app.listen(3000, () => console.log('NSUK Bot running on port 3000'));function getClass(cgpa) {
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
