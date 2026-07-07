console.log("AI Proctoring Content Script Loaded.");

// Basic template for a content script that could monitor tab focus
window.addEventListener("blur", () => {
  console.log("Tab lost focus! Potential cheating event.");
});

window.addEventListener("focus", () => {
  console.log("Tab regained focus.");
});
