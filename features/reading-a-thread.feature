Feature: Reading a thread
  As someone picking up where an agent got to
  I want the conversation laid out with the working folded away
  So I can see what was said and what came of it

  Background:
    Given the app is connected to a runner with the demo threads

  @transcript.user @transcript.reply
  Scenario: The conversation reads top to bottom
    When I open the thread "Make uploads resume after a crash"
    Then the transcript shows my message "Uploads start again from zero if the app quits"
    And the transcript shows a reply starting "Uploads now pick up where they stopped"
    And my message "Uploads start again from zero" comes before the reply "Uploads now pick up"

  @transcript.workedfor
  Scenario: What the agent did is folded into one line
    When I open the thread "Make uploads resume after a crash"
    Then the agent's work is folded into a line saying "Worked for 2m 14s"

  @transcript.workedfor @transcript.tool
  Scenario: Opening that line shows each thing it did
    When I open the thread "Make uploads resume after a crash"
    And I open the line saying "Worked for 2m 14s"
    Then the transcript shows a step starting "Read"

  @transcript.turnfooter
  Scenario: A finished turn says how long it took and what it cost
    When I open the thread "Make uploads resume after a crash"
    Then a turn ends with a line saying "2m 14s, $0.38"

  @transcript.changes
  Scenario: A turn that edited files says so
    When I open the thread "Make uploads resume after a crash"
    Then the transcript has a card saying "Edited 2 files"

  @transcript.error
  Scenario: A failed turn says what went wrong
    When I open the thread "Make a poster for the meetup"
    Then the transcript shows an error
