// Initialize floating ball functionality
function initFloatingBall() {
  const ball = document.getElementById('minimax-floating-ball');
  if (!ball) return;

  // Initial animation
  ball.style.opacity = '0';
  ball.style.transform = 'translateY(20px)';

  setTimeout(() => {
    ball.style.opacity = '1';
    ball.style.transform = 'translateY(0)';
  }, 500);

  // Handle logo click
  const ballContent = ball.querySelector('.minimax-ball-content');
  ballContent.addEventListener('click', function (e) {
    e.stopPropagation();
    window.open('https://agent.minimax.io/', '_blank');
    ball.style.transform = 'scale(0.95)';
    setTimeout(() => {
      ball.style.transform = 'scale(1)';
    }, 100);
  });

  // Handle close button click
  const closeIcon = ball.querySelector('.minimax-close-icon');
  closeIcon.addEventListener('click', function (e) {
    e.stopPropagation();
    ball.style.opacity = '0';
    ball.style.transform = 'translateY(20px)';

    setTimeout(() => {
      ball.style.display = 'none';
    }, 300);
  });
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initFloatingBall); 
