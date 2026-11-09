Feature: Answering the agent
  As someone an agent is waiting on
  I want its questions and requests in front of me with the answers ready to press
  So I can unblock it in a click

  Background:
    Given the app is connected to a runner with the demo threads

  @transcript.approval
  Scenario: An approval shows exactly what it wants to run
    When I open the thread "Make uploads resume after a crash"
    Then an approval card asks to run "rm -rf .build DerivedData"

  @transcript.approval @transcript.approval.settled
  Scenario: Allowing it lets the agent carry on
    When I open the thread "Make uploads resume after a crash"
    And I press "Allow"
    Then the approval card has gone
    And the transcript shows a reply starting "Done"

  @transcript.approval
  Scenario: Denying it stops that action
    When I open the thread "Make uploads resume after a crash"
    And I press "Deny"
    Then the approval for "rm -rf .build DerivedData" says it was denied
    And the transcript shows a reply starting "OK, I left it alone"

  @transcript.question
  Scenario: A question card offers its answers
    When I open the thread "Pick a colour for the new Share button"
    Then a question card asks "Which colour should the Share button be?"

  @transcript.question
  Scenario: Picking an answer and sending it settles the card
    When I open the thread "Pick a colour for the new Share button"
    And I pick the answer "Accent blue" on the question card
    And I send my answer
    Then the transcript shows a reply starting "Going with Accent blue"

  @card.needsyou @card.answers
  Scenario: A turn that needs me shows what it wants decided
    When I open the thread "Ship the beta to TestFlight"
    Then the thread ends with a card of things for me to decide
