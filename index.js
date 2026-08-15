const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

const sessions = {};
const reminders = {};

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

// NSUK Academic Calendar 2025/2026 Second Semester
const academicCalendar = {
  semesterStart: "February 3, 2026",
  midSemesterBreak: "April 14 - April 20, 2026",
  examStart: "May 26, 2026",
  semesterEnd: "June 20, 2026",
  currentSemester: "Second Semester 2025/2026"
};

// PT5 Weekly Lecture Timetable
const pt5Timetable = {
  friday: [
    { time: "2:30 PM - 4:00 PM", code: "CMPP522", title: "Algorithms & Structured Programming", lecturer: "Prof. Rashidah Funke Olanrewaju" },
    { time: "4:00 PM - 6:00 PM", code: "CMPP521", title: "Artificial Intelligence", lecturer: "Prof. N.V. Blamah" }
  ],
  saturday: [
    { time: "8:00 AM - 10:00 AM", code: "CMPP524", title: "System Modelling and Simulation", lecturer: "Mrs. Yunus Fatima" },
    { time: "10:00 AM - 12:00 PM", code: "CMPP523", title: "Distributed Computing Systems", lecturer: "Dr. M. Olalere" },
    { time: "4:00 PM - 6:00 PM", code: "CMPP525", title: "Introduction to Data Mining and Knowledge Discovery", lecturer: "Dr. Abdullahi Salihu Audu" }
  ]
};

// PT5 Exam Timetable
const pt5Exams = [
  { code: "CMPP521", title: "Artificial Intelligence", day: "Friday", time: "4:00 PM - 6:00 PM", week: "Exam Week 1" },
  { code: "CMPP522", title: "Algorithms & Structured Programming", day: "Friday", time: "2:30 PM - 4:00 PM", week: "Exam Week 1" },
  { code: "CMPP523", title: "Distributed Computing Systems", day: "Saturday", time: "10:00 AM - 12:00 PM", week: "Exam Week 1" },
  { code: "CMPP524", title: "System Modelling and Simulation", day: "Saturday", time: "8:00 AM - 10:00 AM", week: "Exam Week 1" },
  { code: "CMPP525", title: "Data Mining and Knowledge Discovery", day: "Saturday", time: "4:00 PM - 6:00 PM", week: "Exam Week 1" }
];

// PT5 Courses
const courseData = {
  "computer science": {
    500: {
      second: [
        { code: "CMPP521", title: "Artificial Intelligence", units: 3, status: "Compulsory", lecturer: "Prof. N.V. Blamah" },
        { code: "CMPP522", title: "Algorithms & Structured Programming", units: 3, status: "Compulsory", lecturer: "Prof. Rashidah Funke Olanrewaju" },
        { code: "CMPP523", title: "Distributed Computing Systems", units: 3, status: "Compulsory", lecturer: "Dr. M. Olalere" },
        { code: "CMPP524", title: "System Modelling and Simulation", units: 3, status: "Compulsory", lecturer: "Mrs. Yunus Fatima" },
        { code: "CMPP525", title: "Introduction to Data Mining and Knowledge Discovery", units: 3, status: "Compulsory", lecturer: "Dr. Abdullahi Salihu Audu" }
      ]
    }
  }
};

// Ethical guardrail check
function isUnethical(message) {
  const lower = message.toLowerCase();
  const blocked = [
    'exam answer', 'answer the question', 'solve this exam', 'give me the answer',
    'do my assignment', 'write my assignment', 'cheat', 'past question answer',
    'help me cheat', 'write my project', 'do my project for me',
    'give me exam questions', 'leak', 'expo'
  ];
  return blocked.some(phrase => lower.includes(phrase));
}

async function transcribeVoiceNote(mediaUrl) {
  try {
    const authHeader = "Basic " + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + process.env.TWILIO_AUTH_TOKEN).toString('base64');
    const audioResponse = await fetch(mediaUrl, { headers: { "Authorization": authHeader } });
    const audioBuffer = await audioResponse.arrayBuffer();
    const audioBytes = Buffer.from(audioBuffer);

    const formData = new FormData();
    const blob = new Blob([audioBytes], { type: 'audio/ogg' });
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', 'whisper-large-v3');
    formData.append('language', 'en');

    const groqResponse = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.GROQ_API_KEY },
      body: formData
    });

    const result = await groqResponse.json();
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
          content: "You are an assistant helping Nigerian university students at NSUK (Nasarawa State University Keffi). You understand English, Nigerian Pidgin, and informal student language. Current step: " + currentStep + ". Session data: " + JSON.stringify(sessionData) + ". Extract info from the student message and return ONLY JSON. For menu intent return {\"intent\": \"courses\" or \"cgpa\" or \"target\" or \"alerts\" or \"profile\" or \"timetable\" or \"exam\" or \"calendar\" or \"reminder\"}. For department return {\"department\": \"name\"}. For level return {\"level\": number}. For semester return {\"semester\": \"first\" or \"second\"}. For number return {\"number\": value}. For grade return {\"grade\": \"A\" or \"B\" or \"C\" or \"D\" or \"E\" or \"F\"}. For yes/no return {\"answer\": \"yes\" or \"no\"}. For course code return {\"code\": \"XXXNNN\"}. For day of week return {\"day\": \"monday\" or \"tuesday\" or \"wednesday\" or \"thursday\" or \"friday\" or \"saturday\" or \"sunday\" or \"today\" or \"tomorrow\"}. For reminder details return {\"reminderCourse\": \"course name or code\", \"reminderType\": \"test\" or \"assignment\" or \"exam\", \"reminderDate\": \"date string\", \"reminderTime\": \"time string\"}. If unclear return {\"unclear\": true}."
        },
        { role: "user", content: message }
      ],
      max_tokens: 200,
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

function getTodaySchedule() {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const today = days[new Date().getDay()];
  return getScheduleForDay(today);
}

function getScheduleForDay(day) {
  const schedule = pt5Timetable[day];
  if (!schedule || schedule.length === 0) {
    return "No classes on " + day.charAt(0).toUpperCase() + day.slice(1) + ". Enjoy your day! 😊";
  }
  let msg = "📋 Classes for " + day.charAt(0).toUpperCase() + day.slice(1) + ":\n\n";
  schedule.forEach((c, i) => {
    msg += (i + 1) + ". " + c.time + "\n   " + c.code + " — " + c.title + "\n   👨‍🏫 " + c.lecturer + "\n\n";
  });
  return msg.trim();
}

function getExamInfo(courseCode) {
  const exam = pt5Exams.find(e => e.code.toLowerCase() === courseCode.toLowerCase());
  if (!exam) return null;
  return "📝 " + exam.code + " — " + exam.title + "\n\nExam Day: " + exam.day + "\nTime: " + exam.time + "\nPeriod: " + exam.week + "\n\nMake sure you have your matric card and arrive 30 minutes early. 📌";
}

function formatCourses(courses, department, level, semester) {
  let msg = "📚 " + department.toUpperCase() + " — " + level + " Level (PT5), " + semester.charAt(0).toUpperCase() + semester.slice(1) + " Semester\n\n";
  msg += "Courses to register:\n\n";
  let totalUnits = 0;
  courses.forEach((c, i) => {
    msg += (i + 1) + ". " + c.code + " — " + c.title + "\n   Units: " + c.units + " | " + c.status + "\n   👨‍🏫 " + c.lecturer + "\n\n";
    totalUnits += c.units;
  });
  msg += "Total Units: " + totalUnits;
  msg += "\n\nType *menu* to go back or ask me anything about your courses.";
  return msg;
}

function mainMenu() {
  return "👋 Welcome to NSUK Bot!\n\nYour smart student assistant. What do you need?\n\n1️⃣ What should I register this semester?\n2️⃣ Calculate my CGPA\n3️⃣ Set a CGPA target\n4️⃣ My class timetable\n5️⃣ Exam timetable\n6️⃣ Academic calendar\n7️⃣ Set a reminder\n8️⃣ Portal/result alerts\n9️⃣ My profile\n\nReply with a number or just tell me what you need in your own words 💬";
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

// Reminder checker — runs every minute
setInterval(async () => {
  const now = new Date();
  for (const phone in reminders) {
    const userReminders = reminders[phone];
    for (let i = userReminders.length - 1; i >= 0; i--) {
      const r = userReminders[i];
      const reminderTime = new Date(r.fireAt);
      if (now >= reminderTime) {
        await sendReply(phone, "🔔 *Reminder!*\n\n" + r.message);
        userReminders.splice(i, 1);
      }
    }
  }
}, 60000);

app.post('/webhook', async (req, res) => {
  let message = req.body.Body ? req.body.Body.trim() : '';
  const from = req.body.From.replace('whatsapp:', '');
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  res.sendStatus(200);

  const session = getSession(from);

  try {
    // Voice note handler
    if (mediaUrl && mediaType && mediaType.includes('audio')) {
      await sendReply(from, "🎤 Got your voice note, transcribing...");
      const transcribed = await transcribeVoiceNote(mediaUrl);
      if (transcribed) {
        message = transcribed;
        await sendReply(from, "I heard: \"" + message + "\"\n\nProcessing...");
      } else {
        await sendReply(from, "Sorry I could not transcribe that. Please type your message.");
        return;
      }
    }

    if (!message) {
      await sendReply(from, mainMenu());
      return;
    }

    // Ethical guardrail
    if (isUnethical(message)) {
      await sendReply(from, "❌ I can't help with that.\n\nI am built to help you study smarter and plan better — not to assist with anything that compromises academic integrity.\n\nType *menu* to see what I can help you with.");
      return;
    }

    const lower = message.toLowerCase();

    if (lower === 'menu' || lower === 'home' || lower === 'start' || lower === 'hi' || lower === 'hello') {
      resetSession(from);
      await sendReply(from, mainMenu());
      return;
    }

    const understood = await understandMessage(message, session.step, session.data);
    console.log('Understood:', JSON.stringify(understood));

    // MAIN MENU ROUTING
    if (session.step === 'menu') {

      // Courses
      if (message === '1' || understood.intent === 'courses') {
        session.step = 'courses_dept';
        await sendReply(from, "📚 Course Registration Guide\n\nWhat is your department?\n(e.g. Computer Science)");
        return;
      }

      // CGPA
      if (message === '2' || understood.intent === 'cgpa') {
        session.step = 'cgpa_how_many';
        session.data.courses = [];
        await sendReply(from, "📊 CGPA Calculator\n\nHow many courses did you take this semester?");
        return;
      }

      // Target
      if (message === '3' || understood.intent === 'target') {
        session.step = 'target_current';
        await sendReply(from, "🎯 CGPA Target Planner\n\nWhat is your current CGPA? (e.g. 3.20)");
        return;
      }

      // Timetable
      if (message === '4' || understood.intent === 'timetable') {
        session.step = 'timetable_day';
        await sendReply(from, "📋 Class Timetable\n\nWhich day do you want?\n\nReply: *today*, *friday*, or *saturday*");
        return;
      }

      // Exam timetable
      if (message === '5' || understood.intent === 'exam') {
        session.step = 'exam_lookup';
        await sendReply(from, "📝 Exam Timetable\n\nWhich course do you want to check?\n\nReply with course code (e.g. CMPP521)\nor type *all* to see all your exams");
        return;
      }

      // Academic calendar
      if (message === '6' || understood.intent === 'calendar') {
        await sendReply(from,
          "📅 *NSUK Academic Calendar*\n*" + academicCalendar.currentSemester + "*\n\n" +
          "📌 Semester Start: " + academicCalendar.semesterStart + "\n" +
          "☕ Mid-Semester Break: " + academicCalendar.midSemesterBreak + "\n" +
          "📝 Exams Begin: " + academicCalendar.examStart + "\n" +
          "🏁 Semester Ends: " + academicCalendar.semesterEnd + "\n\n" +
          "Type *menu* to go back."
        );
        return;
      }

      // Reminder
      if (message === '7' || understood.intent === 'reminder') {
        session.step = 'reminder_what';
        await sendReply(from, "🔔 Set a Reminder\n\nWhat do you want me to remind you about?\n(e.g. CMPP522 test on Thursday, CMPP524 assignment due Friday)");
        return;
      }

      // Alerts
      if (message === '8' || understood.intent === 'alerts') {
        session.step = 'alerts_dept';
        await sendReply(from, "🔔 Portal and Result Alerts\n\nWhat is your department?");
        return;
      }

      // Profile
      if (message === '9' || understood.intent === 'profile') {
        const p = session.data.profile;
        if (!p) {
          await sendReply(from, "📋 No profile saved yet.\n\nUse the menu to get started.\n\nType *menu* to go back.");
          return;
        }
        await sendReply(from,
          "📋 *Your Profile*\n\n" +
          "Department: " + (p.dept || 'Not set') + "\n" +
          "Level: " + (p.level || 'Not set') + "\n" +
          "Semester: " + (p.semester || 'Not set') + "\n" +
          "CGPA: " + (p.cgpa || 'Not calculated') + "\n" +
          "Class: " + (p.class || 'Not calculated') + "\n" +
          "Alerts: " + (p.alerts || 'Not subscribed') + "\n\n" +
          "Type *menu* to go back."
        );
        return;
      }

      await sendReply(from, mainMenu());
      return;
    }

    // TIMETABLE FLOW
    if (session.step === 'timetable_day') {
      const day = understood.day || lower;
      let targetDay = day;
      if (day === 'today') {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        targetDay = days[new Date().getDay()];
      }
      if (day === 'tomorrow') {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        targetDay = days[(new Date().getDay() + 1) % 7];
      }
      const schedule = getScheduleForDay(targetDay);
      await sendReply(from, schedule + "\n\nType *menu* to go back.");
      session.step = 'menu';
      return;
    }

    // EXAM LOOKUP FLOW
    if (session.step === 'exam_lookup') {
      if (lower === 'all') {
        let msg = "📝 *Your PT5 Exam Timetable*\n\n";
        pt5Exams.forEach((e, i) => {
          msg += (i + 1) + ". " + e.code + " — " + e.title + "\n   📅 " + e.day + " | " + e.time + "\n   " + e.week + "\n\n";
        });
        msg += "⚠️ Arrive 30 minutes early with your matric card.\n\nType *menu* to go back.";
        await sendReply(from, msg);
        session.step = 'menu';
        return;
      }
      const code = understood.code || message.toUpperCase().trim();
      const examInfo = getExamInfo(code);
      if (examInfo) {
        await sendReply(from, examInfo + "\n\nType *menu* to go back.");
      } else {
        await sendReply(from, "I could not find exam info for \"" + code + "\".\n\nTry: CMPP521, CMPP522, CMPP523, CMPP524, or CMPP525\n\nOr type *all* to see all exams.");
      }
      session.step = 'menu';
      return;
    }

    // REMINDER FLOW
    if (session.step === 'reminder_what') {
      session.data.reminderText = message;
      session.step = 'reminder_date';
      await sendReply(from, "📅 What date and time should I remind you?\n\n(e.g. Friday 9am, Thursday 6pm)");
      return;
    }

    if (session.step === 'reminder_date') {
      if (!reminders[from]) reminders[from] = [];

      // Set reminder 1 hour from now as default if we can't parse
      const fireAt = new Date(Date.now() + 60 * 60 * 1000);

      reminders[from].push({
        message: "Don't forget: " + session.data.reminderText,
        fireAt: fireAt.toISOString(),
        dateText: message
      });

      await sendReply(from,
        "✅ *Reminder Set!*\n\n" +
        "I will remind you about:\n" + session.data.reminderText + "\n\n" +
        "When: " + message + "\n\n" +
        "I'll send you a WhatsApp alert when it's time. 🔔\n\nType *menu* to go back."
      );
      session.step = 'menu';
      return;
    }

    // COURSE REGISTRATION FLOW
    if (session.step === 'courses_dept') {
      const dept = understood.department || message;
      session.data.coursesDept = dept;
      session.step = 'courses_level';
      await sendReply(from, "What level are you?\n(e.g. 100, 200, 300, 400, 500)");
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

      const deptKey = session.data.coursesDept.toLowerCase();
      const deptData = courseData[deptKey];
      const levelData = deptData ? deptData[session.data.coursesLevel] : null;
      const courses = levelData ? levelData[sem] : null;

      if (!courses) {
        await sendReply(from, "I don't have the course list for " + session.data.coursesDept + " " + session.data.coursesLevel + " Level yet.\n\nCurrently available: Computer Science 500 Level Second Semester.\n\nMore departments loading soon!\n\nType *menu* to go back.");
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
      await sendReply(from, "Course 1 of " + num + "\n\nEnter course code:\n(e.g. CMPP521)");
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
      await sendReply(from, "Grade for " + session.data.currentCourse.code + "?\n\nReply: A, B, C, D, E, or F");
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

      let summary = "📊 *Your Results*\n\n";
      session.data.courses.forEach(c => {
        summary += c.code + " — " + c.grade + " (" + c.units + " units)\n";
      });
      summary += "\nSemester GPA: " + gpa;
      summary += "\nDegree Class: " + cls;
      summary += "\n\nSave to profile? Reply YES or NO.";

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
        await sendReply(from, "Please enter a valid target between 0.00 and 5.00.");
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
        await sendReply(from, "Please enter a valid number.");
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
        await sendReply(from, "Please enter a valid number.");
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
      const gp = parseFloat(requiredGP);

      let advice = "";
      if (gp > 5) advice = "❌ This target is no longer mathematically achievable. Consider adjusting your goal.";
      else if (gp >= 4.5) advice = "💪 You need mostly A's — very ambitious but possible with serious focus.";
      else if (gp >= 3.5) advice = "📚 You need a mix of A's and B's — very doable with consistent effort.";
      else if (gp >= 2.5) advice = "✅ You need mostly B's and C's — achievable with steady work.";
      else advice = "😊 You are in a comfortable position — keep it up!";

      await sendReply(from,
        "🎯 *CGPA Target Plan*\n\n" +
        "Current CGPA: " + current + "\n" +
        "Target CGPA: " + target + "\n" +
        "Units remaining: " + left + "\n\n" +
        "You need an average of " + requiredGP + " GP per unit in your remaining courses.\n\n" +
        advice + "\n\nType *menu* to go back."
      );
      session.step = 'menu';
      return;
    }

    // ALERTS FLOW
    if (session.step === 'alerts_dept') {
      const dept = understood.department || message;
      session.data.alertDept = dept;
      session.step = 'alerts_level';
      await sendReply(from, "What level are you?");
      return;
    }

    if (session.step === 'alerts_level') {
      const level = understood.level || parseInt(message);
      if (![100, 200, 300, 400, 500].includes(level)) {
        await sendReply(from, "Please enter a valid level: 100, 200, 300, 400, or 500.");
        return;
      }
      if (!session.data.profile) session.data.profile = {};
      session.data.profile.dept = session.data.alertDept;
      session.data.profile.level = level;
      session.data.profile.alerts = session.data.alertDept + " " + level + "L";
      session.step = 'menu';
      await sendReply(from,
        "✅ Subscribed to alerts for:\n\n" +
        session.data.alertDept + " — " + level + " Level\n\n" +
        "You will be notified when:\n" +
        "🔔 Results are released\n" +
        "🔔 Portal opens for registration\n" +
        "🔔 Important announcements drop\n\n" +
        "Type *menu* to go back."
      );
      return;
    }

    // Fallback
    await sendReply(from, "Type *menu* to see what I can help you with 👋");

  } catch (err) {
    console.error('Webhook error:', err.message);
    await sendReply(from, 'Something went wrong, try again 🙏');
  }
});

app.get('/', (req, res) => res.send('NSUK Bot is running!'));

app.listen(3000, () => console.log('NSUK Bot running on port 3000'));
