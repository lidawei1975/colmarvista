
const canvas = document.getElementById('timerCanvas');

var duration;
var redPercent = 0.25; // turn red when the remaining time is less than 25% of the total time
var remainingTime;

let timerInterval;
let startTime =0;

var paused_time_start = 0;
var stoppedTime = 0;

var percent = 0;


function drawCircle() {

    const ctx = canvas.getContext('2d');
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(centerX, centerY) * 0.8; // Adjust radius as needed

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, radius, 0, 2 * Math.PI);
    if (percent > 1 - redPercent/100.0) {
        ctx.strokeStyle = 'red';
    }
    else {
        ctx.strokeStyle = 'steelblue';
    }
    ctx.lineWidth = radius/5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, radius, -Math.PI / 2, (-Math.PI / 2) + (2 * Math.PI * percent), false);
    ctx.strokeStyle = 'lightgray';
    ctx.lineWidth =  radius/5;
    ctx.stroke();
    ctx.font = parseInt(radius/3).toString().concat('px Arial');
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
    let elapsedTime = Math.floor((currentTime - stoppedTime - startTime) / 1000);

    remainingTime = duration - elapsedTime;

    if (remainingTime > 0) {
        percent = (duration - remainingTime) / duration;
        drawCircle();
    } else {
        clearInterval(timerInterval);
        percent = 1;
        drawCircle();
    }
}
function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
    paused_time_start = Date.now();
    clearInterval(timerInterval);
}

function resumeTimer() {
    stoppedTime += Date.now() - paused_time_start;
    timerInterval = setInterval(updateTimer, 1000);
}

$(document).ready(function () {

    const setButton = document.getElementById('setButton');
    const pauseButton = document.getElementById('pauseButton');
    const resumeButton = document.getElementById('resumeButton');
    const durationInput = document.getElementById('durationInput');
    const redPercentInput = document.getElementById('redPercentInput');

    duration = parseInt(durationInput.value);
    remainingTime = duration;

    setButton.addEventListener('click', () => {
        duration = parseInt(durationInput.value);
        redPercent = parseFloat(redPercentInput.value);
        remainingTime = duration; //unit is seconds
        startTime = Date.now();
        paused_time_start = 0;
        stoppedTime = 0;
        percent = 0;
        drawCircle();
        startTimer();
        /**
         * Enable pause buttons after setting the timer.
         */
        pauseButton.disabled = false;
    });

    pauseButton.addEventListener('click', () => {
        stopTimer();
        /**
         * Disable pause button and enable resume button after pausing the timer.
         */
        pauseButton.disabled = true;
        resumeButton.disabled = false;
    });

    resumeButton.addEventListener('click', () => {
        resumeTimer();
        /**
         * Disable resume button and enable pause button after resuming the timer.
         */
        resumeButton.disabled = true;
        pauseButton.disabled = false;
    });


    drawCircle();

    const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
            const rect = entry.contentRect;
            canvas.width = rect.width - 40;
            canvas.height = rect.height - 40 ;
            drawCircle();
        }
    });

    let parentElement = canvas.parentElement;
    resizeObserver.observe(parentElement);

    /**
     * Enable set button after JS is loaded.
     */
    setButton.disabled = false;
});
