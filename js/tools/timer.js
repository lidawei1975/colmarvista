const durationInput = document.getElementById('durationInput');
const canvas = document.getElementById('timerCanvas');
const ctx = canvas.getContext('2d');

var duration;
var duration_initial; 
var remainingTime;

let timerInterval;
let startTime = Date.now();

var paused_time = 0;


function drawCircle(percent) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, 80, 0, 2 * Math.PI);
    if (percent > 0.8) {
        ctx.strokeStyle = 'red';
    }
    else {
        ctx.strokeStyle = 'steelblue';
    }
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, 80, -Math.PI / 2, (-Math.PI / 2) + (2 * Math.PI * percent), false);
    ctx.strokeStyle = 'lightgray';
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.font = '24px Arial';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    /**
     * Convert remaining time in seconds to MM:SS format.
     */

    ctx.fillText(formatTime(remainingTime), canvas.width / 2, canvas.height / 2);
}

function formatTime(seconds) {
    if (seconds <= 0) {
        return '00:00'; // Return 00:00 if the time is less than or equal to 0
    }
    else {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }
}

function updateTimer() {

    /**
     * Correct the remaining time, base on current time and start time.
    */
    let currentTime = Date.now();
    // Calculate the elapsed time since the timer started
    let elapsedTime = Math.floor((currentTime - startTime) / 1000);

    remainingTime = duration - elapsedTime;

    if (remainingTime > 0) {
        const percent = (duration - remainingTime) / duration_initial;
        drawCircle(percent);
    } else {
        clearInterval(timerInterval);
        drawCircle(1);
    }
}
function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
    paused_time = remainingTime;
    clearInterval(timerInterval);
}

function resumeTimer() {
    duration = paused_time;
    startTimer();
}

$(document).ready(function () {

    const setButton = document.getElementById('setButton');
    const pauseButton = document.getElementById('pauseButton');
    const resumeButton = document.getElementById('resumeButton');

    duration = parseInt(durationInput.value);
    remainingTime = duration;

    setButton.addEventListener('click', () => {
        duration = parseInt(durationInput.value);
        duration_initial = duration;
        remainingTime = duration; //unit is seconds
        startTime = Date.now();
        startTimer();
    });

    pauseButton.addEventListener('click', () => {
        stopTimer();
    });

    resumeButton.addEventListener('click', () => {
        resumeTimer();
    });


    drawCircle(0);
});
